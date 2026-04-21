// ── 상태 ──────────────────────────────────────────────────
const state = {
  keywords: [],
  excludeKeywords: [],
  isRunning: false,
  hasLibraryCreds: false,
  hasAnthropicKey: false,
  hasClaudeCli: false,
  lastOutputDir: null,
};

// ── 초기화 ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupTagInput('kw-input', 'keyword-tag-wrap', state.keywords, updateRunButton);
  setupTagInput('ex-input', 'exclude-tag-wrap', state.excludeKeywords, () => {});
  setupSortOptions();
  setupDropZone();

  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    applyConfig(cfg);
  } catch (e) {
    console.warn('설정 로드 실패:', e);
  }
});

function applyConfig(cfg) {
  if (cfg.libraryId) document.getElementById('library-id').value = cfg.libraryId;
  if (cfg.lastOutputDir) document.getElementById('output-dir').value = cfg.lastOutputDir;
  if (cfg.pages) document.getElementById('pages').value = cfg.pages;
  if (cfg.yearFrom) document.getElementById('year-from').value = cfg.yearFrom;
  if (cfg.yearTo) document.getElementById('year-to').value = cfg.yearTo;
  if (cfg.kciOnly) document.getElementById('kci-only').checked = true;
  if (cfg.minCitations) document.getElementById('min-citations').value = cfg.minCitations;
  if (cfg.topN) document.getElementById('top-n').value = cfg.topN;

  // 마지막 키워드 태그 복원
  if (cfg.lastKeywords && cfg.lastKeywords.length > 0) {
    cfg.lastKeywords.forEach(kw => addTag(kw, 'keyword-tag-wrap', state.keywords, 'kw-input', updateRunButton));
  }

  // 제외 키워드 복원
  if (cfg.excludeKeywords && cfg.excludeKeywords.length > 0) {
    cfg.excludeKeywords.forEach(kw => addTag(kw, 'exclude-tag-wrap', state.excludeKeywords, 'ex-input', () => {}));
  }

  // 자격증명 상태
  state.hasLibraryCreds = cfg.hasLibraryCredentials;
  state.hasAnthropicKey = cfg.hasAnthropicKey;
  state.hasClaudeCli = cfg.hasClaudeCli;
  updateClaudeStatus();

  // 분류 기능: API 키나 Claude CLI 있으면 기본 활성화
  const canClassify = cfg.hasAnthropicKey || cfg.hasClaudeCli;
  document.getElementById('skip-classify').checked = !canClassify;

  // 로그인 여부에 따라 화면 전환
  showScreen(cfg.hasLibraryCredentials ? 'main' : 'login');

  updateRunButton();
}

// ── 화면 전환 ─────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('screen-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('screen-main').classList.toggle('hidden', name !== 'main');
}

// ── 카드 토글 ─────────────────────────────────────────────
function toggleCard(id) {
  const body = document.getElementById(`body-${id}`);
  const header = body.previousElementSibling;
  body.classList.toggle('collapsed');
  header.classList.toggle('open');
}

// ── 태그 입력 ─────────────────────────────────────────────
function setupTagInput(inputId, wrapId, arr, onChange) {
  const input = document.getElementById(inputId);
  let isComposing = false;

  input.addEventListener('compositionstart', () => { isComposing = true; });
  input.addEventListener('compositionend', () => { isComposing = false; });

  input.addEventListener('keydown', (e) => {
    if (isComposing) return;
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim();
      if (val) addTag(val, wrapId, arr, inputId, onChange);
    } else if (e.key === 'Backspace' && !input.value && arr.length > 0) {
      removeTag(arr.length - 1, wrapId, arr, inputId, onChange);
    }
  });

  input.addEventListener('input', () => {
    if (isComposing) return;
    if (input.value.endsWith(',')) {
      const val = input.value.slice(0, -1).trim();
      if (val) addTag(val, wrapId, arr, inputId, onChange);
      else input.value = '';
    }
  });

  input.addEventListener('blur', () => {
    const val = input.value.replace(/,$/, '').trim();
    if (val) addTag(val, wrapId, arr, inputId, onChange);
  });
}

function addTag(value, wrapId, arr, inputId, onChange) {
  if (!value || arr.includes(value)) return;
  arr.push(value);
  renderTags(wrapId, arr, inputId, onChange);
  onChange();
}

function removeTag(idx, wrapId, arr, inputId, onChange) {
  arr.splice(idx, 1);
  renderTags(wrapId, arr, inputId, onChange);
  onChange();
}

function renderTags(wrapId, arr, inputId, onChange) {
  const wrap = document.getElementById(wrapId);
  const input = document.getElementById(inputId);
  input.value = '';

  // 기존 태그 제거
  wrap.querySelectorAll('.tag').forEach(t => t.remove());

  arr.forEach((tag, i) => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `${escapeHtml(tag)}<button class="tag-remove" title="제거">×</button>`;
    el.querySelector('.tag-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(i, wrapId, arr, inputId, onChange);
    });
    wrap.insertBefore(el, input);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 파일 업로드 / 드래그앤드롭 ───────────────────────────
let selectedFile = null;

function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  input.addEventListener('change', () => {
    if (input.files[0]) setFile(input.files[0]);
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });
}

function setFile(file) {
  const allowed = ['.pdf', '.docx', '.txt'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    document.getElementById('extract-status').textContent = '⚠️ PDF, DOCX, TXT만 지원합니다';
    document.getElementById('extract-status').className = 'save-status err';
    return;
  }
  selectedFile = file;
  document.getElementById('drop-file-name').textContent = file.name;
  document.getElementById('drop-file-row').style.display = 'flex';
  document.getElementById('btn-extract').disabled = false;
  document.getElementById('extract-status').textContent = '';
}

function clearFile() {
  selectedFile = null;
  document.getElementById('drop-file-name').textContent = '';
  document.getElementById('drop-file-row').style.display = 'none';
  document.getElementById('btn-extract').disabled = true;
  document.getElementById('extract-status').textContent = '';
  document.getElementById('file-input').value = '';
}

async function extractKeywords() {
  if (!selectedFile) return;
  const status = document.getElementById('extract-status');
  const btn = document.getElementById('btn-extract');
  btn.disabled = true;
  setStatus(status, '🔄 키워드 추출 중...', 'pending');

  const formData = new FormData();
  formData.append('file', selectedFile);

  try {
    const r = await fetch('/api/extract-keywords', { method: 'POST', body: formData });
    const data = await r.json();
    if (!r.ok) { setStatus(status, `❌ ${data.error}`, 'err'); return; }

    data.keywords.forEach(kw => {
      if (kw) addTag(kw, 'keyword-tag-wrap', state.keywords, 'kw-input', updateRunButton);
    });
    setStatus(status, `✅ ${data.keywords.length}개 키워드 추출 완료`, 'ok');
  } catch (e) {
    setStatus(status, `❌ ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 정렬 버튼 ─────────────────────────────────────────────
function setupSortOptions() {
  document.querySelectorAll('.sort-option').forEach(label => {
    label.addEventListener('click', () => {
      document.querySelectorAll('.sort-option').forEach(l => l.classList.remove('selected'));
      label.classList.add('selected');
    });
  });
}

function getSort() {
  const checked = document.querySelector('input[name="sort"]:checked');
  return checked ? checked.value : 'rank';
}

// ── 도서관 자격증명 검증 + 저장 ──────────────────────────
async function saveLibraryCredentials() {
  const libraryId = document.getElementById('library-id').value.trim();
  const libraryPw = document.getElementById('library-pw').value.trim();
  const status = document.getElementById('lib-status');
  const btn = document.getElementById('btn-verify-creds');

  if (!libraryId || !libraryPw) {
    setStatus(status, '⚠️ ID와 PW 모두 입력하세요', 'err');
    return;
  }

  btn.disabled = true;
  setStatus(status, '🔄 로그인 확인 중... (10~20초)', 'pending');

  try {
    const r = await fetch('/api/verify-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryId, libraryPw }),
    });
    const data = await r.json();
    if (data.ok) {
      setStatus(status, '✅ 로그인 확인 및 저장 완료', 'ok');
      state.hasLibraryCreds = true;
      document.getElementById('library-pw').value = '';
      setTimeout(() => showScreen('main'), 800);
    } else {
      setStatus(status, `❌ ${data.error}`, 'err');
    }
  } catch (e) {
    setStatus(status, `❌ ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function saveAnthropicKey() {
  const key = document.getElementById('anthropic-key').value.trim();
  const status = document.getElementById('api-status');
  if (!key) { setStatus(status, '⚠️ 키를 입력하세요', 'err'); return; }

  try {
    const r = await fetch('/api/save-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: key }),
    });
    const data = await r.json();
    if (data.ok) {
      setStatus(status, '✅ 저장됨', 'ok');
      state.hasAnthropicKey = true;
      document.getElementById('anthropic-key').value = '';
    } else {
      setStatus(status, `❌ ${data.error}`, 'err');
    }
  } catch (e) {
    setStatus(status, `❌ ${e.message}`, 'err');
  }
}

function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = `save-status ${cls}`;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function updateClaudeStatus() {
  const el = document.getElementById('claude-cli-status');
  if (!el) return;
  if (state.hasAnthropicKey) {
    el.textContent = 'API 키 사용';
    el.className = 'status-badge ok';
  } else if (state.hasClaudeCli) {
    el.textContent = '로컬 Claude 사용';
    el.className = 'status-badge ok';
  } else {
    el.textContent = '분류 기능 사용 불가';
    el.className = 'status-badge missing';
  }
}

// ── 저장 폴더 열기 ────────────────────────────────────────
async function openOutputFolder() {
  if (!state.lastOutputDir) return;
  try {
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.lastOutputDir }),
    });
  } catch (e) {
    console.error('폴더 열기 실패:', e);
  }
}

// ── 폴더 선택 ─────────────────────────────────────────────
async function pickFolder() {
  try {
    const r = await fetch('/api/pick-folder', { method: 'POST' });
    const data = await r.json();
    if (!data.cancelled && data.path) {
      document.getElementById('output-dir').value = data.path;
    }
  } catch (e) {
    console.error('폴더 선택 실패:', e);
  }
}

// ── 실행 버튼 상태 ────────────────────────────────────────
function updateRunButton() {
  const btn = document.getElementById('btn-run');
  const info = document.getElementById('run-info');
  const hasKw = state.keywords.length > 0;
  const hasCreds = state.hasLibraryCreds;

  btn.disabled = !hasKw || !hasCreds || state.isRunning;

  if (!hasKw && !hasCreds) info.textContent = '키워드와 도서관 ID를 설정하면 활성화됩니다.';
  else if (!hasKw) info.textContent = '검색 키워드를 추가해 주세요.';
  else if (!hasCreds) info.textContent = '도서관 ID를 저장해 주세요.';
  else if (state.isRunning) info.textContent = '실행 중...';
  else info.textContent = `키워드 ${state.keywords.length}개 · 페이지 ${document.getElementById('pages').value}개 수집 준비`;
}

// ── 실행 / 중단 ───────────────────────────────────────────
function toggleRun() {
  if (state.isRunning) {
    stopPipeline();
  } else {
    startPipeline();
  }
}

async function startPipeline() {
  const params = {
    keywords: [...state.keywords],
    excludeKeywords: [...state.excludeKeywords],
    pages: parseInt(document.getElementById('pages').value) || 3,
    yearFrom: document.getElementById('year-from').value || null,
    yearTo: document.getElementById('year-to').value || null,
    kciOnly: document.getElementById('kci-only').checked,
    sort: getSort(),
    topN: parseInt(document.getElementById('top-n').value) || null,
    minCitations: parseInt(document.getElementById('min-citations').value) || 0,
    skipDownload: document.getElementById('skip-download').checked,
    skipClassify: document.getElementById('skip-classify').checked,
    outputDir: document.getElementById('output-dir').value || null,
    libraryId: document.getElementById('library-id').value.trim() || null,
  };

  state.isRunning = true;
  const btn = document.getElementById('btn-run');
  btn.classList.add('running');
  document.getElementById('run-icon').textContent = '⏹';
  document.getElementById('run-label').textContent = '중단';
  btn.disabled = false;

  const logCard = document.getElementById('log-card');
  const logOutput = document.getElementById('log-output');
  const progressBar = document.getElementById('progress-bar');

  logCard.classList.add('visible');
  logOutput.textContent = '';
  progressBar.style.width = '0%';
  document.getElementById('summary-card').classList.add('hidden');

  let logTotal = 0;
  let logCount = 0;

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const err = await response.json();
      appendLog(`❌ 오류: ${err.error}`, 'log-error');
      finishRun();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const { type, data } = JSON.parse(line.slice(5).trim());
          if (type === 'log') {
            appendLog(data);
            // 진행률 파싱 [N/TOTAL]
            const m = data.match(/\[(\d+)\/(\d+)\]/);
            if (m) {
              logCount = parseInt(m[1]);
              logTotal = parseInt(m[2]);
              progressBar.style.width = `${Math.round((logCount / logTotal) * 100)}%`;
            }
          } else if (type === 'summary') {
            state.lastOutputDir = data.outputDir;
            document.getElementById('summary-total').textContent = data.total;
            document.getElementById('summary-pdfs').textContent = data.pdfCount;
            document.getElementById('summary-path').textContent = data.outputDir;
            document.getElementById('summary-card').classList.remove('hidden');
          } else if (type === 'end') {
            appendLog(data, data.startsWith('✅') ? 'log-success' : 'log-error');
            progressBar.style.width = data.startsWith('✅') ? '100%' : progressBar.style.width;
          }
        } catch {}
      }
    }
  } catch (e) {
    appendLog(`❌ 연결 오류: ${e.message}`, 'log-error');
  }

  finishRun();
}

async function stopPipeline() {
  await fetch('/api/stop', { method: 'POST' });
  appendLog('⏹ 중단 요청됨', 'log-error');
  finishRun();
}

function finishRun() {
  state.isRunning = false;
  const btn = document.getElementById('btn-run');
  btn.classList.remove('running');
  document.getElementById('run-icon').textContent = '▶';
  document.getElementById('run-label').textContent = '수집 시작';
  updateRunButton();
}

function appendLog(text, cls) {
  const el = document.getElementById('log-output');
  if (cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    el.appendChild(span);
  } else {
    el.appendChild(document.createTextNode(text));
  }
  el.scrollTop = el.scrollHeight;
}

// ── 페이지 이탈 시 서버 종료 ──────────────────────────────
window.addEventListener('beforeunload', () => {
  if (!state.isRunning) {
    navigator.sendBeacon('/api/shutdown', '{}');
  }
});
