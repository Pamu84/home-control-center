#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MEDIAMTX_YML="$ROOT_DIR/mediamtx.yml"
CONTAINER_NAME=mediamtx

echo "Starting startup script from $ROOT_DIR"

if command -v docker >/dev/null 2>&1; then
  echo "Docker CLI found"
  # If container exists
  if docker ps --format '{{.Names}}' | grep -w "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Container $CONTAINER_NAME already running"
  elif docker ps -a --format '{{.Names}}' | grep -w "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Container $CONTAINER_NAME exists but is stopped; starting it"
    docker start "$CONTAINER_NAME"
  else
    if [ -f "$MEDIAMTX_YML" ]; then
      echo "Creating and starting container $CONTAINER_NAME"
      docker run -d --name "$CONTAINER_NAME" \
        -p 8554:8554 -p 8000:8000/udp -p 8001:8001/udp \
        -p 8889:8889 -p 8189:8189/udp -p 8888:8888 \
        -v "$MEDIAMTX_YML":/mediamtx.yml \
        --restart unless-stopped bluenviron/mediamtx:latest
    else
      echo "Warning: $MEDIAMTX_YML not found; skipping MediaMTX container creation"
    fi
  fi

  echo "Waiting for MediaMTX to become ready (timeout 20s)"
  for i in $(seq 1 20); do
    if docker logs "$CONTAINER_NAME" --tail 50 2>/dev/null | grep -E "\[WebRTC\] listener opened|path camera100.*ready" >/dev/null 2>&1; then
      echo "MediaMTX is ready"
      break
    fi
    echo -n '.'
    sleep 1
  done
  echo
else
  echo "Docker CLI not found; skipping MediaMTX startup. Install Docker to enable automatic MediaMTX launch."
fi

# Ensure Node server is restarted (stop if running, then start)
if pgrep -f "node .*server.js" >/dev/null 2>&1; then
  echo "Node server already running; attempting to stop it for restart..."
  PIDS=$(pgrep -f "node .*server.js" || true)
  for pid in $PIDS; do
    echo "Stopping node server pid $pid"
    kill $pid >/dev/null 2>&1 || true
  done
  # wait a short time for graceful shutdown
  for i in $(seq 1 5); do
    if pgrep -f "node .*server.js" >/dev/null 2>&1; then
      sleep 1
    else
      break
    fi
  done
  if pgrep -f "node .*server.js" >/dev/null 2>&1; then
    echo "Node server did not stop gracefully; killing forcefully"
    pkill -9 -f "node .*server.js" || true
  fi
fi

echo "Starting Node server (server.js)"
exec node server.js
