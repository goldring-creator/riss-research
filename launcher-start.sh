#!/bin/bash
# RISS 논문 수집기 — 서버 시작 스크립트

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.riss"
PORT_FILE="$CONFIG_DIR/port"

mkdir -p "$CONFIG_DIR"

# node_modules 없으면 설치
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "패키지 설치 중..."
  cd "$APP_DIR" && npm install --production
fi

# 이미 서버 실행 중인지 확인
if [ -f "$PORT_FILE" ]; then
  EXISTING_PORT=$(cat "$PORT_FILE")
  if curl -s "http://127.0.0.1:$EXISTING_PORT/api/config" > /dev/null 2>&1; then
    open "http://127.0.0.1:$EXISTING_PORT"
    exit 0
  fi
fi

# 서버 시작
cd "$APP_DIR"
node launcher/server.js &
SERVER_PID=$!

# 포트 파일 생성 대기 (최대 10초)
for i in $(seq 1 20); do
  sleep 0.5
  if [ -f "$PORT_FILE" ]; then
    PORT=$(cat "$PORT_FILE")
    if curl -s "http://127.0.0.1:$PORT/api/config" > /dev/null 2>&1; then
      open "http://127.0.0.1:$PORT"
      # 서버가 종료될 때까지 대기 (탭 닫으면 shutdown API가 호출됨)
      wait $SERVER_PID
      exit 0
    fi
  fi
done

echo "서버 시작 실패"
exit 1
