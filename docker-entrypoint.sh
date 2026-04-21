#!/bin/sh
set -e

# Forward termination signals to both processes for clean shutdown
trap 'kill -TERM $NGINX_PID $NODE_PID 2>/dev/null; wait $NGINX_PID' TERM INT QUIT

# ── Start nginx first so Sevalla's health check can connect on port 80 ─────
nginx -g 'daemon off;' &
NGINX_PID=$!
echo "nginx started (PID $NGINX_PID)" >&2

# ── Start Node lead API ──────────────────────────────────────────────────
node /app/server.js &
NODE_PID=$!
echo "node started (PID $NODE_PID)" >&2

# ── Keep container alive by waiting on nginx ─────────────────────────────
wait $NGINX_PID
