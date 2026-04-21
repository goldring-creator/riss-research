const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const net = require('net');
const multer = require('multer');

const credentials = require('./credentials');
const config = require('./config');
const runner = require('./runner');

function findClaudeCli() {
  try {
    const p = execSync(
      'export PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH; which claude 2>/dev/null',
      { shell: '/bin/bash', encoding: 'utf8' }
    ).trim();
    return p || null;
  } catch { return null; }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

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
    hasClaudeCli: !!findClaudeCli(),
  });
});

// ── 자격증명 저장 (API 키 전용) ───────────────────────────
app.post('/api/save-credentials', (req, res) => {
  const { anthropicKey } = req.body;
  try {
    if (anthropicKey) {
      credentials.keychainSet('__anthropic__', anthropicKey);
      config.save({ hasAnthropicKey: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 도서관 자격증명 검증 + 저장 ───────────────────────────
app.post('/api/verify-credentials', async (req, res) => {
  const { libraryId, libraryPw } = req.body;
  if (!libraryId || !libraryPw) {
    return res.status(400).json({ ok: false, error: 'ID와 PW를 모두 입력하세요.' });
  }

  let browser = null;
  try {
    const { chromium } = require('playwright');
    const { loginAndGetRiss } = require('../core/riss-auth');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const rissPage = await loginAndGetRiss(context, { libraryId, libraryPw });
    await rissPage.close();
    await context.close();

    // 로그인 성공 → Keychain 저장
    credentials.keychainSet(libraryId, libraryPw);
    config.save({ libraryId, hasLibraryCredentials: true });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ── 폴더 선택 (macOS: osascript / Windows: PowerShell) ────
app.post('/api/pick-folder', (req, res) => {
  try {
    let result;
    if (process.platform === 'win32') {
      const tmp = require('path').join(require('os').tmpdir(), 'riss_folder.ps1');
      require('fs').writeFileSync(tmp, `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '저장 위치를 선택하세요'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }
`, 'utf8');
      result = execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { timeout: 30000 }).toString().trim();
      try { require('fs').unlinkSync(tmp); } catch {}
      if (!result) return res.json({ cancelled: true });
    } else {
      result = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "다운로드 위치를 선택하세요")'`,
        { timeout: 30000 }
      ).toString().trim();
    }
    res.json({ path: result });
  } catch (e) {
    if (e.status === 1) return res.json({ cancelled: true });
    res.status(500).json({ error: e.message });
  }
});

// ── 파일 업로드 → 키워드 추출 ────────────────────────────
app.post('/api/extract-keywords', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없거나 지원하지 않는 형식입니다.' });

  const tmpPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    let text = '';

    if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const buf = fs.readFileSync(tmpPath);
      const parser = new PDFParse({ data: buf });
      await parser.load(buf);
      const data = await parser.getText();
      text = data.text;
      await parser.destroy().catch(() => {});
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: tmpPath });
      text = result.value;
    } else {
      text = fs.readFileSync(tmpPath, 'utf8');
    }

    // 3000자로 제한 (Claude 비용 절감)
    text = text.replace(/\s+/g, ' ').trim().slice(0, 3000);
    if (!text) return res.status(400).json({ error: '텍스트를 추출할 수 없습니다.' });

    // Claude로 키워드 추출
    const anthropicKey = credentials.keychainGet('__anthropic__') || process.env.ANTHROPIC_API_KEY;
    let keywords = [];

    if (anthropicKey) {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `다음 연구 내용을 읽고, RISS에서 관련 논문을 검색할 한국어 키워드 3~5개를 추출하세요.
키워드만 쉼표로 구분하여 한 줄로 출력하세요. 설명 없이 키워드만.

연구 내용:
${text}`,
        }],
      });
      keywords = msg.content[0].text.split(',').map(k => k.trim()).filter(Boolean);
    } else {
      const claudeCliPath = findClaudeCli();
      if (!claudeCliPath) return res.status(400).json({ error: 'Claude API 키 또는 Claude CLI가 필요합니다.' });
      const prompt = `다음 연구 내용을 읽고, RISS에서 관련 논문을 검색할 한국어 키워드 3~5개를 추출하세요.\n키워드만 쉼표로 구분하여 한 줄로 출력하세요. 설명 없이 키워드만.\n\n연구 내용:\n${text}`;
      const r = spawnSync(claudeCliPath, ['-p', prompt], {
        encoding: 'utf8', timeout: 60000,
        env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH}` },
      });
      if (r.error) return res.status(500).json({ error: `Claude CLI 오류: ${r.error.message}` });
      keywords = r.stdout.split(',').map(k => k.trim()).filter(Boolean);
    }

    res.json({ keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
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
  const claudeCliPath = (!anthropicKey && !params.skipClassify) ? findClaudeCli() : null;
  const useClaudeCli = !!claudeCliPath;

  if (params.keywords && params.keywords.length > 0) {
    config.save({ lastKeywords: params.keywords, lastOutputDir: params.outputDir || cfg.lastOutputDir });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  send('start', '파이프라인 시작...\n');

  const resolvedOutputDir = params.outputDir || path.join(__dirname, '..', 'output');

  runner.run(
    { ...params, libraryId: lid, libraryPw: lpw, anthropicKey, useClaudeCli, claudeCliPath },
    (text) => send('log', text),
    (code) => {
      if (code === 0) {
        let total = 0, pdfCount = 0;
        try {
          const metaPath = path.join(resolvedOutputDir, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            const papers = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            total = Array.isArray(papers) ? papers.length : 0;
          }
        } catch {}
        try {
          const countPdfs = (dir) => {
            if (!fs.existsSync(dir)) return 0;
            return fs.readdirSync(dir).reduce((acc, f) => {
              const fp = path.join(dir, f);
              return acc + (fs.statSync(fp).isDirectory() ? countPdfs(fp) : f.endsWith('.pdf') ? 1 : 0);
            }, 0);
          };
          pdfCount = countPdfs(path.join(resolvedOutputDir, 'pdfs'));
        } catch {}

        send('summary', { outputDir: resolvedOutputDir, total, pdfCount });

        try {
          if (process.platform !== 'win32') {
            execSync(
              `osascript -e 'display notification "총 ${total}건 수집 완료 · PDF ${pdfCount}개" with title "RISS 논문 수집기" sound name "Glass"'`,
              { timeout: 5000 }
            );
          }
        } catch {}
      }

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

// ── 저장 폴더 열기 ────────────────────────────────────────
app.post('/api/open-folder', (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: '경로가 없습니다.' });
  try {
    if (process.platform === 'win32') {
      execSync(`explorer "${folderPath.replace(/\//g, '\\')}"`, { timeout: 5000 });
    } else {
      execSync(`open "${folderPath}"`, { timeout: 5000 });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
