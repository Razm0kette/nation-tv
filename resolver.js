// nation-media resolver — transforme un lien YouTube en flux direct (sans pub) et le diffuse aux joueurs.
// Tourne sur le VPS (service systemd), derrière Caddy en https.
'use strict';
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const { URL } = require('url');

const PORT   = parseInt(process.env.PORT || '3777', 10);
const TOKEN  = process.env.TOKEN || '';
const PUBLIC = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // ex: https://1.2.3.4.nip.io
const COOKIES = '/opt/nation-media/cookies.txt';
const YTDLP = process.env.YTDLP || '/usr/local/bin/yt-dlp';

const FORMATS = {
  video: '18/best[ext=mp4][height<=480]/best[height<=480]/best', // mp4 muxé (image + son) pour les télés
  audio: 'bestaudio[ext=m4a]/bestaudio/best',                     // audio seul pour voitures / enceintes
};

const cache = new Map();   // id|kind -> { url, mime, exp }
const info  = new Map();   // id -> { title, author, duration, live, exp }

function log(...a) { console.log(new Date().toISOString(), ...a); }

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const full = ['--no-playlist', '--no-warnings', '-q'];
    if (fs.existsSync(COOKIES)) full.push('--cookies', COOKIES);
    execFile(YTDLP, full.concat(args), { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim().split('\n').pop()));
      resolve(stdout.trim());
    });
  });
}

function videoId(u) {
  const m = u.match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getInfo(id) {
  const c = info.get(id);
  if (c && c.exp > Date.now()) return c;
  const out = await ytdlp(['-J', `https://www.youtube.com/watch?v=${id}`]);
  const j = JSON.parse(out);
  const d = { title: j.title || 'Vidéo YouTube', author: j.uploader || j.channel || '', duration: j.duration || 0,
    live: !!j.is_live, thumb: j.thumbnail || `https://img.youtube.com/vi/${id}/mqdefault.jpg`, exp: Date.now() + 6 * 3600e3 };
  info.set(id, d);
  return d;
}

async function getStream(id, kind) {
  const key = `${id}|${kind}`;
  const c = cache.get(key);
  if (c && c.exp > Date.now()) return c;
  const out = await ytdlp(['-g', '-f', FORMATS[kind] || FORMATS.audio, `https://www.youtube.com/watch?v=${id}`]);
  const url = out.split('\n')[0];
  if (!url) throw new Error('aucun flux trouvé');
  const d = { url, exp: Date.now() + 3 * 3600e3 };
  cache.set(key, d);
  return d;
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// relais du flux googlevideo vers le joueur (avec Range pour pouvoir avancer / se resynchroniser)
function proxy(res, target, range, retry) {
  const u = new URL(target);
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
  if (range) headers.Range = range;
  const req = (u.protocol === 'https:' ? https : http).get(u, { headers }, (up) => {
    if (up.statusCode === 403 && !retry) { up.resume(); return res.emit('nm-refresh'); }
    const h = {
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
    };
    for (const k of ['content-length', 'content-range']) if (up.headers[k]) h[k] = up.headers[k];
    res.writeHead(up.statusCode, h);
    up.pipe(res);
    res.on('close', () => up.destroy());
  });
  req.on('error', (e) => { if (!res.headersSent) send(res, 502, { error: 'flux injoignable : ' + e.message }); else res.destroy(); });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    if (u.pathname === '/health') return send(res, 200, { ok: true });

    if (!TOKEN || u.searchParams.get('token') !== TOKEN) return send(res, 403, { error: 'token invalide' });

    if (u.pathname === '/resolve') {
      const link = u.searchParams.get('url') || '';
      const id = videoId(link);
      if (!id) return send(res, 400, { error: 'lien YouTube non reconnu' });
      const i = await getInfo(id);
      if (i.live) return send(res, 200, { error: 'live non supporté', live: true, title: i.title });
      // on prépare l'audio tout de suite (l'image viendra à la demande)
      await getStream(id, 'audio');
      const base = PUBLIC || `http://${req.headers.host}`;
      return send(res, 200, {
        videoId: id, title: i.title, author: i.author, duration: i.duration, thumb: i.thumb,
        audio: `${base}/stream/${id}/audio?token=${TOKEN}`,
        video: `${base}/stream/${id}/video?token=${TOKEN}`,
      });
    }

    const m = u.pathname.match(/^\/stream\/([A-Za-z0-9_-]{11})\/(audio|video)$/);
    if (m) {
      const [, id, kind] = m;
      const s = await getStream(id, kind);
      res.once('nm-refresh', async () => {           // lien expiré côté Google : on le régénère une fois
        try { cache.delete(`${id}|${kind}`); const s2 = await getStream(id, kind); proxy(res, s2.url, req.headers.range, true); }
        catch (e) { send(res, 502, { error: e.message }); }
      });
      return proxy(res, s.url, req.headers.range, false);
    }

    send(res, 404, { error: 'inconnu' });
  } catch (e) {
    log('erreur', e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => log(`nation-media resolver sur 127.0.0.1:${PORT} (public: ${PUBLIC || 'non défini'})`));
