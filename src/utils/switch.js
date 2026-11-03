const fs = require('fs');
const path = require('path');
const { info: logInfo } = require('./logger');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'ia_enabled.json');

function readState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { enabled: false };
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return { enabled: !!parsed.enabled, toggledAt: parsed.toggledAt || null };
  } catch {
    return { enabled: false };
  }
}

function writeState(enabled) {
  const state = { enabled, toggledAt: new Date().toISOString() };
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Never throw — silently fail
  }
  logInfo(`[switch] IA ${enabled ? 'ENABLED' : 'DISABLED'} at ${state.toggledAt}`);
  return state;
}

function isEnabled() {
  return readState().enabled;
}

function getState() {
  return readState();
}

function enable() {
  return writeState(true);
}

function disable() {
  return writeState(false);
}

function toggle() {
  const current = readState();
  const newState = !current.enabled;
  writeState(newState);
  return newState;
}

module.exports = { isEnabled, getState, enable, disable, toggle };