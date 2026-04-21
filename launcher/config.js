const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.riss');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PORT_FILE = path.join(CONFIG_DIR, 'port');

const DEFAULTS = {
  libraryId: '',
  lastOutputDir: path.join(os.homedir(), 'Desktop', 'RISS_출력'),
  lastKeywords: [],
  pages: 3,
  yearFrom: '',
  yearTo: '',
  kciOnly: false,
  sort: 'rank',
  topN: '',
  minCitations: 0,
  excludeKeywords: [],
  hasLibraryCredentials: false,
  hasAnthropicKey: false,
};

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(data) {
  ensureDir();
  const current = load();
  const merged = { ...current, ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  return merged;
}

function writePort(port) {
  ensureDir();
  fs.writeFileSync(PORT_FILE, String(port), 'utf8');
}

function readPort() {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim());
  } catch {
    return null;
  }
}

module.exports = { load, save, writePort, readPort, CONFIG_DIR };
