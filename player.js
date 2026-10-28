// nation_media — lecteur (YouTube IFrame API + HTML5). Tourne dans l'iframe de dui.html.
// Parle avec l'enveloppe uniquement par postMessage.
(function () {
  const params = new URLSearchParams(location.search);
  const KIND = params.get('kind') || 'tv';
  const RES  = params.get('res')  || 'nation_media';
  const KEY  = params.get('key')  || '';

  let yt = null, ytReady = false;
  let mode = null, current = null, volume = 0, pendingPlay = null, lastDurationSent = 0;

  const idle = document.getElementById('idle');
  const vid  = document.getElementById('vid');
  // Retour vers Lua : callback NUI (best-effort, le serveur sait aussi se débrouiller sans)
  const cbNames = { ready: 'duiReady', ended: 'duiEnded', duration: 'duiDuration', error: 'duiError' };
  const send = (event, data) => {
    if (cbNames[event]) try {
      fetch(`https://${RES}/${cbNames[event]}`, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ key: KEY }, data || {})) }).catch(() => {});
    } catch (e) {}
    try { if (window.parent !== window) window.parent.postMessage(Object.assign({ nm: true, event }, data || {}), '*'); } catch (e) {}
  };
  const showIdle = (on) => { idle.style.display = on ? 'flex' : 'none'; };
  const statusEl = document.getElementById('status');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  setStatus('page chargée, attente API YouTube…');

  // ---------------------------------------------------------------- YouTube
  let ytCreated = false;
  window.onYouTubeIframeAPIReady = function () {
    if (ytCreated) return;
    ytCreated = true;
    setStatus('API YouTube chargée, création du lecteur…');
    try {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      host: 'https://www.youtube.com',
      playerVars: {
        autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3,
        modestbranding: 1, playsinline: 1, origin: location.origin, widget_referrer: location.href,
      },
      events: {
        onReady: () => { ytReady = true; setStatus('API YouTube prête'); applyVolume(); if (pendingPlay) { const p = pendingPlay; pendingPlay = null; play(p); } },
        onStateChange: (e) => {
          const names = { '-1': 'non démarré', 0: 'terminé', 1: 'lecture', 2: 'pause', 3: 'chargement', 5: 'prêt (cued)' };
          setStatus('YouTube : ' + (names[e.data] || e.data) + (current ? ' — ' + current.title : ''));
          if (!current || mode !== 'youtube') return;
          if (e.data === YT.PlayerState.ENDED) send('ended', { uid: current.uid });
          if (e.data === YT.PlayerState.PLAYING) {
            send('playing', { uid: current.uid });
            const d = yt.getDuration();
            if (d > 0 && Math.abs(d - lastDurationSent) > 1) { lastDurationSent = d; send('duration', { uid: current.uid, duration: d }); }
          }
        },
        onError: (e) => {
          if (!current) return;
          const reasons = { 2: 'lien invalide', 5: 'erreur lecteur', 100: 'vidéo introuvable',
            101: 'intégration refusée par la chaîne', 150: 'intégration refusée par la chaîne',
            153: 'Referer invalide — héberge player.html en https (voir Config.PlayerUrl)' };
          setStatus('ERREUR YouTube ' + e.data + ' : ' + (reasons[e.data] || ''));
          send('error', { uid: current.uid, reason: reasons[e.data] || ('code ' + e.data) });
        },
      },
    });
    } catch (err) { setStatus('ERREUR création lecteur : ' + err); }
  };
  // sécurité : si l'API est là mais n'a pas appelé le hook (ordre de chargement), on force
  let apiWait = 0;
  const apiTimer = setInterval(() => {
    apiWait++;
    if (ytCreated) { clearInterval(apiTimer); return; }
    if (window.YT && typeof YT.Player === 'function') { clearInterval(apiTimer); window.onYouTubeIframeAPIReady(); return; }
    if (window.YT && typeof YT.ready === 'function') { YT.ready(window.onYouTubeIframeAPIReady); }
    if (apiWait === 10) setStatus('API YouTube toujours absente après 5 s (script bloqué ?)');
    if (apiWait > 60) clearInterval(apiTimer);
  }, 500);

  // ---------------------------------------------------------------- HTML5 direct
  vid.addEventListener('playing', () => { if (current) send('playing', { uid: current.uid }); });
  vid.addEventListener('ended', () => { if (current && mode === 'direct') send('ended', { uid: current.uid }); });
  vid.addEventListener('error', () => { if (current && mode === 'direct') send('error', { uid: current.uid, reason: 'lien non lisible' }); });
  vid.addEventListener('loadedmetadata', () => {
    if (current && mode === 'direct' && isFinite(vid.duration) && vid.duration > 0) send('duration', { uid: current.uid, duration: vid.duration });
  });

  // ---------------------------------------------------------------- commandes
  function applyVolume() {
    const v = 0; // le son passe par xsound : l'écran est toujours muet
    if (yt && ytReady) { try { if (v <= 0) yt.mute(); else { yt.unMute(); yt.setVolume(v); } } catch (e) {} }
    vid.volume = v / 100; vid.muted = v <= 0;
  }

  function stopAll() {
    if (yt && ytReady) { try { yt.stopVideo(); } catch (e) {} }
    document.getElementById('yt').style.display = 'none';
    vid.pause(); vid.removeAttribute('src'); vid.load(); vid.style.display = 'none';
    mode = null; current = null; lastDurationSent = 0; pendingPlay = null;
    showIdle(true);
  }

  function play(msg) {
    // déjà en train de lire ce média -> simple recalage
    if (current && msg.item && current.uid === msg.item.uid && (mode === 'direct' || ytReady)) { sync(msg); return; }
    current = msg.item;
    showIdle(false);
    if (current.type === 'youtube') {
      if (!ytReady) { pendingPlay = msg; return; }
      mode = 'youtube';
      vid.pause(); vid.style.display = 'none';
      document.getElementById('yt').style.display = 'block';
      try { yt.mute(); } catch (e) {}
      setStatus('chargement de ' + current.videoId + '…');
      yt.loadVideoById({ videoId: current.videoId, startSeconds: Math.max(0, msg.pos || 0) });
      applyVolume();
      if (msg.paused) setTimeout(() => { try { yt.pauseVideo(); } catch (e) {} }, 400);
      else kick(current.uid);
    } else {
      mode = 'direct';
      if (yt && ytReady) { try { yt.stopVideo(); } catch (e) {} }
      document.getElementById('yt').style.display = 'none';
      vid.style.display = KIND === 'tv' ? 'block' : 'none';
      vid.src = current.url;
      vid.currentTime = Math.max(0, msg.pos || 0);
      applyVolume();
      if (msg.paused) vid.pause(); else vid.play().catch(() => {});
    }
  }

  // relance tant que YouTube n'est pas en lecture (autoplay capricieux)
  function kick(uid) {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (!current || current.uid !== uid || mode !== 'youtube' || !ytReady || tries > 12) { clearInterval(t); return; }
      let st = -2; try { st = yt.getPlayerState(); } catch (e) {}
      if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) { clearInterval(t); return; }
      try { yt.mute(); yt.playVideo(); } catch (e) {}
      setStatus('relance ' + tries + ' (état ' + st + ')');
    }, 1000);
  }

  function sync(msg) {
    if (!current) return;
    const tol = msg.tolerance || 1.2;
    if (mode === 'youtube' && ytReady) {
      const st = yt.getPlayerState();
      if (msg.paused) { if (st === YT.PlayerState.PLAYING) yt.pauseVideo(); if (msg.force) yt.seekTo(msg.pos, true); return; }
      if (st === YT.PlayerState.PAUSED || st === YT.PlayerState.CUED) yt.playVideo();
      const cur = yt.getCurrentTime() || 0;
      if (msg.force || Math.abs(cur - msg.pos) > tol) yt.seekTo(msg.pos, true);
    } else if (mode === 'direct') {
      if (msg.paused) { vid.pause(); if (msg.force) vid.currentTime = msg.pos; return; }
      if (vid.paused) vid.play().catch(() => {});
      if (msg.force || Math.abs(vid.currentTime - msg.pos) > tol) vid.currentTime = msg.pos;
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.action) return;
    switch (msg.action) {
      case 'play':   if (!current || !msg.item || current.uid !== msg.item.uid) setStatus('ordre de lecture reçu'); play(msg); break;
      case 'sync':   sync(msg); break;
      case 'stop':   stopAll(); break;
      case 'volume': volume = msg.volume || 0; applyVolume(); break;
    }
  });

  setStatus('page chargée, attente API YouTube…');
  send('ready', {});
})();
