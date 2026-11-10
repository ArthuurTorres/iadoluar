const fs = require('fs');
const path = require('path');
const { info: logInfo } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HANDOFFS_FILE = path.join(DATA_DIR, 'handoffs.json');
const OVERRIDE_FILE = path.join(DATA_DIR, 'handoff_override.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function safePhone(phoneNumber) {
  return String(phoneNumber || '').replace(/[^0-9]/g, '');
}

function isHandoffTriggered(phoneNumber) {
  const safe = safePhone(phoneNumber);
  if (!safe) return false;
  const handoffs = readJson(HANDOFFS_FILE);
  return !!handoffs[safe];
}

/**
 * Marca o contato como atendido por humano. A partir daí a IA fica silenciosa
 * até alguém devolver a conversa para ela em resumeAI().
 */
function triggerHandoff(phoneNumber, reason = 'manual') {
  const safe = safePhone(phoneNumber);
  if (!safe) return;
  const handoffs = readJson(HANDOFFS_FILE);
  const previous = handoffs[safe] || {};
  handoffs[safe] = {
    triggeredAt: previous.triggeredAt || new Date().toISOString(),
    reason,
    updatedAt: new Date().toISOString(),
  };
  writeJson(HANDOFFS_FILE, handoffs);
  // Reativar o handoff anula um "devolver para IA" anterior.
  if (isOverrideActive(safe)) {
    const overrides = readJson(OVERRIDE_FILE);
    delete overrides[safe];
    writeJson(OVERRIDE_FILE, overrides);
  }
  logInfo('[handoff] Contato marcado como atendimento humano', { phoneNumber: safe.replace(/(\d{2})\d+(\d{4})/, '$1*****$2'), reason });
}

function isOverrideActive(phoneNumber) {
  const safe = safePhone(phoneNumber);
  if (!safe) return false;
  const overrides = readJson(OVERRIDE_FILE);
  return !!overrides[safe];
}

/**
 * Devolve a conversa para a IA. O registro de handoff é mantido no histórico
 * (auditoria), mas a IA volta a responder este contato.
 */
function resumeAI(phoneNumber) {
  const safe = safePhone(phoneNumber);
  if (!safe) return false;
  const overrides = readJson(OVERRIDE_FILE);
  overrides[safe] = { resumedAt: new Date().toISOString() };
  writeJson(OVERRIDE_FILE, overrides);
  logInfo('[handoff] IA reativada para o contato', { phoneNumber: safe.replace(/(\d{2})\d+(\d{4})/, '$1*****$2') });
  return true;
}

function shouldSilence(phoneNumber) {
  return isHandoffTriggered(phoneNumber) && !isOverrideActive(phoneNumber);
}

/**
 * Lista os contatos em atendimento humano (a IA está silenciosa para eles).
 */
function listHandoffs() {
  const handoffs = readJson(HANDOFFS_FILE);
  return Object.entries(handoffs)
    .filter(([phone]) => !isOverrideActive(phone))
    .map(([phone, data]) => ({ phone, ...data }))
    .sort((a, b) => String(b.updatedAt || b.triggeredAt).localeCompare(String(a.updatedAt || a.triggeredAt)));
}

module.exports = { isHandoffTriggered, triggerHandoff, isOverrideActive, resumeAI, shouldSilence, listHandoffs };