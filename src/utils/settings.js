const fs = require('fs');
const path = require('path');
const { info: logInfo } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Limites aceitos por cada temporizador (ms). Valores fora disso são descartados.
const LIMITS = {
  debounceMs: { min: 200, max: 30000 },
  typingDelayMs: { min: 0, max: 20000 },
  humanDelayMs: { min: 0, max: 20000 },
  interMessageDelayMs: { min: 0, max: 20000 },
};

// Padrão: respeita a variável de ambiente (se existir) para não quebrar deploys antigos.
const DEFAULTS = {
  debounceMs: parseInt(process.env.DEBOUNCE_MS || '2500', 10),
  typingDelayMs: parseInt(process.env.TYPING_DELAY_MS || '2500', 10),
  humanDelayMs: parseInt(process.env.HUMAN_DELAY_MS || '4500', 10),
  interMessageDelayMs: parseInt(process.env.INTER_MESSAGE_DELAY_MS || '2500', 10),
};

function readJson() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Configuração vigente dos temporizadores.
 * Lida do disco a cada chamada para que o painel admin altere sem reiniciar o processo.
 */
function getSettings() {
  const stored = readJson();
  const result = { ...DEFAULTS };
  for (const key of Object.keys(LIMITS)) {
    const value = Number(stored[key]);
    if (Number.isFinite(value)) {
      const { min, max } = LIMITS[key];
      result[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  return result;
}

/**
 * Aplica um patch parcial, descartando chaves desconhecidas e valores inválidos.
 * Retorna a configuração resultante.
 */
function updateSettings(patch) {
  const current = getSettings();
  const next = { ...current };
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!LIMITS[key]) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const { min, max } = LIMITS[key];
    next[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  logInfo('[settings] Temporizadores atualizados', next);
  return next;
}

module.exports = { getSettings, updateSettings, LIMITS, DEFAULTS };