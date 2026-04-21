const { spawn } = require('child_process');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'core');

let activeProcess = null;

function buildArgs(params) {
  const args = [];
  (params.keywords || []).forEach(kw => { args.push('--keyword', kw); });
  if (params.pages) args.push('--pages', String(params.pages));
  if (params.yearFrom) args.push('--year-from', params.yearFrom);
  if (params.yearTo) args.push('--year-to', params.yearTo);
  if (params.kciOnly) args.push('--kci-only');
  if (params.sort) args.push('--sort', params.sort);
  if (params.topN) args.push('--top-n', String(params.topN));
  if (params.minCitations) args.push('--min-citations', String(params.minCitations));
  if (params.excludeKeywords && params.excludeKeywords.length > 0)
    args.push('--exclude', params.excludeKeywords.join(','));
  if (params.skipDownload) args.push('--skip-download');
  if (params.skipClassify) args.push('--skip-classify');
  if (params.libraryId) args.push('--library-id', params.libraryId);
  if (params.libraryPw) args.push('--library-pw', params.libraryPw);
  if (params.outputDir) args.push('--output-dir', params.outputDir);
  return args;
}

function run(params, onData, onEnd) {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }

  const args = buildArgs(params);
  const env = { ...process.env };
  if (params.anthropicKey) env.ANTHROPIC_API_KEY = params.anthropicKey;

  activeProcess = spawn('node', [path.join(CORE_DIR, 'riss-main.js'), ...args], {
    cwd: CORE_DIR,
    env,
  });

  activeProcess.stdout.on('data', d => onData(d.toString()));
  activeProcess.stderr.on('data', d => onData('[stderr] ' + d.toString()));
  activeProcess.on('close', code => {
    activeProcess = null;
    onEnd(code);
  });

  return activeProcess.pid;
}

function stop() {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }
}

function isRunning() {
  return activeProcess !== null;
}

module.exports = { run, stop, isRunning };
