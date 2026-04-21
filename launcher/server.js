const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const net = require('net');

const credentials = require('./credentials');
const config = require('./config');
const runner = require('./runner');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > end) return reject(new Error('사용 가능한 포트 없음'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => { s.close(() => resolve(p)); });
      s.listen(p);
    };
    tryPort(start);
  });
}

// ── 설정 로드 ──────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const cfg = config.load();
  res.json({
    ...cfg,
    hasLibraryCredentials: cfg.libraryId ? credentials.keychainHas(cfg.libraryId) : false,
    hasAnthropicKey: credentials.keychainHas('__anthropic__'),
  });
});

// ── 자격증명 저장 ──────────────────────────────────────────
app.post('/api/save-credentials', (req, res) => {
  const { libraryId, libraryPw, anthropicKey } = req.body;
  try {
    if (libraryId && libraryPw) {
      credentials.keychainSet(libraryId, libraryPw);
      config.save({ libraryId, hasLibraryCredentials: true });
    }
    if (anthropicKey) {
      credentials.keychainSet('__anthropic__', anthropicKey);
      config.save({ hasAnthropicKey: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 폴더 선택 (native macOS picker) ───────────────────────
app.post('/api/pick-folder', (req, res) => {
  try {
    const result = execSync(
      `osascript -e 'POSIX path of (choose folder with prompt "다운로드 위치를 선택하세요")'`,
      { timeout: 30000 }
    ).toString().trim();
    res.json({ path: result });
  } catch (e) {
    if (e.status === 1) return res.json({ cancelled: true });
    res.status(500).json({ error: e.message });
  }
});

// ── 파이프라인 실행 (Server-Sent Events) ──────────────────
app.post('/api/run', (req, res) => {
  if (runner.isRunning()) {
    return res.status(409).json({ error: '이미 실행 중입니다.' });
  }

  const params = req.body;
  const cfg = config.load();
  const lid = params.libraryId || cfg.libraryId;

  if (!lid) return res.status(400).json({ error: '도서관 ID가 설정되지 않았습니다.' });

  const lpw = credentials.keychainGet(lid);
  if (!lpw) return res.status(400).json({ error: '도서관 PW를 먼저 저장하세요.' });

  const anthropicKey = credentials.keychainGet('__anthropic__') || process.env.ANTHROPIC_API_KEY;

  if (params.keywords && params.keywords.length > 0) {
    config.save({ lastKeywords: params.keywords, lastOutputDir: params.outputDir || cfg.lastOutputDir });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  send('start', '파이프라인 시작...\n');

  runner.run(
    { ...params, libraryId: lid, libraryPw: lpw, anthropicKey },
    (text) => send('log', text),
    (code) => {
      send('end', code === 0 ? '✅ 완료' : `❌ 종료 코드: ${code}`);
      res.end();
    }
  );
});

// ── 실행 중단 ─────────────────────────────────────────────
app.post('/api/stop', (req, res) => {
  runner.stop();
  res.json({ ok: true });
});

// ── 서버 종료 ─────────────────────────────────────────────
app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

// ── 서버 시작 ─────────────────────────────────────────────
(async () => {
  const port = await findFreePort(47281, 47299);
  config.writePort(port);
  app.listen(port, '127.0.0.1', () => {
    console.log(`RISS UI 서버: http://127.0.0.1:${port}`);
  });
})();
