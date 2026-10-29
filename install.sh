#!/usr/bin/env bash
# Installation du résolveur nation-media sur un VPS Ubuntu (22.04 / 24.04 / 26.04).
# Usage : curl -fsSL https://razm0kette.github.io/nation-tv/install.sh | sudo bash
set -euo pipefail

BASE="${BASE:-https://razm0kette.github.io/nation-tv}"
DIR=/opt/nation-media

if [ "$(id -u)" -ne 0 ]; then echo "Lance ce script avec sudo."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> Paquets de base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates ffmpeg python3 unzip gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

echo "==> Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> yt-dlp"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

echo "==> deno (requis par yt-dlp pour YouTube)"
if ! command -v deno >/dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh >/dev/null 2>&1 || true
fi

echo "==> Caddy (https automatique)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> Programme"
mkdir -p "$DIR"
curl -fsSL "$BASE/resolver.js" -o "$DIR/resolver.js"

IP="$(curl -fsSL -4 https://ifconfig.me || curl -fsSL -4 https://api.ipify.org)"
HOST="${IP//./-}.nip.io"
PUBLIC_URL="https://$HOST"

if [ ! -f "$DIR/.env" ]; then
  TOKEN="$(openssl rand -hex 16)"
  cat > "$DIR/.env" <<EOF
PORT=3777
TOKEN=$TOKEN
PUBLIC_URL=$PUBLIC_URL
EOF
else
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$PUBLIC_URL#" "$DIR/.env"
fi
TOKEN="$(grep ^TOKEN= "$DIR/.env" | cut -d= -f2)"

cat > /etc/systemd/system/nation-media.service <<EOF
[Unit]
Description=nation-media resolver (YouTube sans pub pour FiveM)
After=network.target

[Service]
EnvironmentFile=$DIR/.env
ExecStart=/usr/bin/node $DIR/resolver.js
Restart=always
RestartSec=3
User=root
WorkingDirectory=$DIR

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$HOST {
    reverse_proxy 127.0.0.1:3777
}
EOF

cat > /usr/local/bin/nation-media-update <<'EOF'
#!/usr/bin/env bash
# Met à jour yt-dlp (à lancer quand YouTube casse la lecture)
yt-dlp -U && systemctl restart nation-media && echo "OK, yt-dlp à jour et service relancé."
EOF
chmod +x /usr/local/bin/nation-media-update

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

systemctl daemon-reload
systemctl enable --now nation-media >/dev/null
systemctl restart nation-media
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

sleep 3
echo
echo "=============================================================="
echo " Installation terminée."
echo " Test : curl -s $PUBLIC_URL/health   (doit répondre {\"ok\":true}, parfois après 1 min le temps du certificat)"
echo
echo " À coller dans nation_media/config.lua :"
echo
echo "   Config.Resolver = {"
echo "       url   = '$PUBLIC_URL',"
echo "       token = '$TOKEN',"
echo "   }"
echo
echo " Mise à jour YouTube plus tard : sudo nation-media-update"
echo "=============================================================="
