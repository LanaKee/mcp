#!/bin/sh
# 화면과 MCP 서버를 한 컨테이너에서 함께 띄운다.
#
# 8787은 자기가 답하지 않는 경로를 PROTOTYPE_ORIGIN으로 넘긴다. 넘길 곳이
# 없으면 화면 요청마다 ECONNREFUSED가 난다. 이미지에 화면을 넣었으므로
# 여기서 같이 올린다. SKIP_PROTOTYPE=1이면 MCP 서버만 띄운다.
set -e

PROTOTYPE_PORT="${PROTOTYPE_PORT:-3100}"

if [ "$SKIP_PROTOTYPE" = "1" ]; then
  echo "[entrypoint] SKIP_PROTOTYPE=1 — MCP 서버만 띄운다. 화면 경로는 404다."
  exec node services/mcp-server/dist/index.js --http
fi

cd /app/prototype-standalone/prototype
PORT="$PROTOTYPE_PORT" HOSTNAME=127.0.0.1 node server.js &
PROTOTYPE_PID=$!
cd /app

# 화면이 실제로 연결을 받을 때까지 기다린다. 뜨기 전에 넘기면 첫 요청이 502다.
i=0
while [ $i -lt 60 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${PROTOTYPE_PORT}/" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$PROTOTYPE_PID" 2>/dev/null; then
    echo "[entrypoint] 화면 프로세스가 죽었다." >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done
echo "[entrypoint] 화면 준비됨: http://127.0.0.1:${PROTOTYPE_PORT}"

trap 'kill "$PROTOTYPE_PID" 2>/dev/null' INT TERM

PROTOTYPE_ORIGIN="http://127.0.0.1:${PROTOTYPE_PORT}" \
  node services/mcp-server/dist/index.js --http &
SERVER_PID=$!

# 어느 쪽이 먼저 죽든 나머지도 내린다. 반쪽만 살아 있으면 "떠 있는데
# 답하지 않는" 상태가 되어 헬스체크가 늦게 알아챈다. busybox ash에는
# `wait -n`이 없으므로 직접 지켜본다.
while kill -0 "$PROTOTYPE_PID" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  wait "$SERVER_PID"
  STATUS=$?
  echo "[entrypoint] MCP 서버가 종료됐다 (status=$STATUS)." >&2
else
  echo "[entrypoint] 화면 프로세스가 종료됐다." >&2
  STATUS=1
fi

kill "$PROTOTYPE_PID" "$SERVER_PID" 2>/dev/null || true
exit $STATUS
