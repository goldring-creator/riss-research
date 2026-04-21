const { execSync } = require('child_process');

const SERVICE = 'riss-launcher';

function keychainSet(account, password) {
  try {
    execSync(
      `security add-generic-password -s ${SERVICE} -a ${JSON.stringify(account)} -w ${JSON.stringify(password)} -U`,
      { stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    throw new Error(`Keychain 저장 실패: ${e.message}`);
  }
}

function keychainGet(account) {
  try {
    const result = execSync(
      `security find-generic-password -s ${SERVICE} -a ${JSON.stringify(account)} -w`,
      { stdio: 'pipe' }
    );
    return result.toString().trim();
  } catch {
    return null;
  }
}

function keychainDelete(account) {
  try {
    execSync(
      `security delete-generic-password -s ${SERVICE} -a ${JSON.stringify(account)}`,
      { stdio: 'pipe' }
    );
  } catch { /* 없으면 무시 */ }
}

function keychainHas(account) {
  return keychainGet(account) !== null;
}

module.exports = { keychainSet, keychainGet, keychainDelete, keychainHas };
