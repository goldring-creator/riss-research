#!/bin/bash
# RISS 논문 수집기 — 더블클릭으로 실행

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/_app"
CONFIG_DIR="$HOME/.riss"
PORT_FILE="$CONFIG_DIR/port"

mkdir -p "$CONFIG_DIR"

# Node.js 설치 확인
if ! command -v node &> /dev/null; then
  osascript -e 'display dialog "Node.js가 설치되어 있지 않습니다.\n\nnodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요." with title "RISS 논문 수집기" buttons {"확인"} default button "확인" with icon stop'
  exit 1
fi

# 패키지 설치 (최초 1회)
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "📦 패키지 설치 중... (최초 1회만 실행됩니다)"
  cd "$APP_DIR" && npm install --production
fi

# Playwright 브라우저 확인
if [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo "🌐 브라우저 설치 중... (최초 1회만 실행됩니다)"
  cd "$APP_DIR" && npx playwright install chromium
fi

# 이미 실행 중인 서버 확인
if [ -f "$PORT_FILE" ]; then
  EXISTING_PORT=$(cat "$PORT_FILE")
  if curl -s "http://127.0.0.1:$EXISTING_PORT/api/config" > /dev/null 2>&1; then
    echo "✅ 이미 실행 중입니다. 브라우저를 열겠습니다..."
    open "http://127.0.0.1:$EXISTING_PORT"
    exit 0
  fi
fi

# 서버 시작
echo "🚀 RISS 논문 수집기 시작 중..."
cd "$APP_DIR"
node launcher/server.js &
SERVER_PID=$!

# 브라우저 열기 (서버 준비 대기)
for i in $(seq 1 20); do
  sleep 0.5
  if [ -f "$PORT_FILE" ]; then
    PORT=$(cat "$PORT_FILE")
    if curl -s "http://127.0.0.1:$PORT/api/config" > /dev/null 2>&1; then
      echo "✅ 브라우저를 여는 중... http://127.0.0.1:$PORT"
      open "http://127.0.0.1:$PORT"
      wait $SERVER_PID
      exit 0
    fi
  fi
done

echo "❌ 서버 시작에 실패했습니다. 로그: /tmp/riss-launcher.log"
exit 1
