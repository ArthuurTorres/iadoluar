const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { info: logInfo, warn: logWarn } = require('./logger');

// Permite isolar o armazenamento em testes (PROMPT_DATA_DIR). Em produção usa data/.
const DATA_DIR = process.env.PROMPT_DATA_DIR
  ? path.resolve(process.env.PROMPT_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
const PROMPT_FILE = path.join(DATA_DIR, 'system-prompt.txt');
const HISTORY_DIR = path.join(DATA_DIR, 'prompt-history');
const INDEX_FILE = path.join(HISTORY_DIR, 'index.json');

// Quantas versões ficam guardadas. As mais antigas são descartadas (arquivo + índice).
const MAX_VERSIONS = 100;
const MAX_SNIPPET = 160;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function readIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    return Array.isArray(parsed?.versions) ? parsed.versions : [];
  } catch (err) {
    logWarn(`[prompt-history] Índice ilegível (${err.message}). Recomeçando vazio.`);
    return [];
  }
}

function writeIndex(versions) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileAtomic(INDEX_FILE, JSON.stringify({ versions }, null, 2));
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

function versionFile(id) {
  return path.join(HISTORY_DIR, `${id}.txt`);
}

function makeId(hash) {
  const iso = new Date().toISOString();
  const stamp = iso.replace(/[-:]/g, '').replace('.', '').slice(0, 18); // YYYYMMDDTHHMMSSmmm
  return `${stamp}-${hash.slice(0, 8)}`;
}

// Garante id único mesmo para o mesmo conteúdo gravado no mesmo milissegundo.
function uniqueId(baseId, versions) {
  const taken = new Set(versions.map((v) => v.id));
  if (!taken.has(baseId)) return baseId;
  let n = 2;
  while (taken.has(`${baseId}-${n}`)) n += 1;
  return `${baseId}-${n}`;
}

/** Lê o prompt em vigor. Retorna null se o arquivo não existir. */
function readPrompt() {
  try {
    if (!fs.existsSync(PROMPT_FILE)) return null;
    return fs.readFileSync(PROMPT_FILE, 'utf-8');
  } catch (err) {
    logWarn(`[prompt-history] Falha ao ler ${PROMPT_FILE}: ${err.message}`);
    return null;
  }
}

/**
 * Histórico do mais recente para o mais antigo, sem o conteúdo (use getVersion para o texto).
 */
function listVersions() {
  const versions = readIndex();
  return versions
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.v.seq) ? a.v.seq : a.i;
      const sb = Number.isFinite(b.v.seq) ? b.v.seq : b.i;
      return sb - sa;
    })
    .map(({ v }) => v);
}

function getVersion(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) return null;
  const entry = readIndex().find((v) => v.id === id);
  if (!entry) return null;
  try {
    const content = fs.readFileSync(versionFile(entry.id), 'utf-8');
    return { ...entry, content };
  } catch (err) {
    logWarn(`[prompt-history] Versão ${id} no índice mas sem arquivo: ${err.message}`);
    return null;
  }
}

function snippetOf(content) {
  const firstLine = String(content)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const text = firstLine || '(vazio)';
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
}

/**
 * Grava uma versão no histórico. Por padrão ignora conteúdo idêntico à versão mais
 * recente (evita poluir o histórico com salvamentos sem mudança).
 * Retorna { created, version }.
 */
function recordVersion(content, options = {}) {
  const { source = 'manual', note = '', force = false } = options;
  if (typeof content !== 'string') {
    throw new Error('Conteúdo do prompt deve ser string');
  }

  const versions = readIndex();
  const latest = versions.length ? versions[versions.length - 1] : null;
  const hash = sha256(content);

  if (!force && latest && latest.sha256 === hash) {
    return { created: false, version: latest };
  }

  const id = uniqueId(makeId(hash), versions);
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileAtomic(versionFile(id), content);

  const lastSeq = versions.length ? Number(versions[versions.length - 1].seq) || 0 : 0;

  const version = {
    id,
    seq: lastSeq + 1,
    createdAt: new Date().toISOString(),
    length: content.length,
    sha256: hash,
    source,
    note: String(note || '').slice(0, 200),
    snippet: snippetOf(content),
  };

  versions.push(version);
  const trimmed = versions.slice(-MAX_VERSIONS);
  const removed = versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS));
  writeIndex(trimmed);
  for (const old of removed) {
    try {
      fs.unlinkSync(versionFile(old.id));
    } catch {
      // arquivo já ausente: nada a fazer
    }
  }

  logInfo(`[prompt-history] Versão ${id} registrada (${source}, ${content.length} chars)`);
  return { created: true, version };
}

/** Registra o prompt em vigor, se ainda não estiver no histórico. */
function snapshotCurrent(options = {}) {
  const current = readPrompt();
  if (current === null || current.trim().length === 0) {
    return { created: false, version: null };
  }
  return recordVersion(current, options);
}

/**
 * Escreve o prompt em vigor e versiona. used por qualquer salvamento.
 */
function savePrompt(content, options = {}) {
  if (typeof content !== 'string') {
    throw new Error('Conteúdo do prompt deve ser string');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(PROMPT_FILE, content);
  return recordVersion(content, options);
}

/**
 * Reverte o prompt para uma versão do histórico.
 * Antes de sobrescrever, registra o estado atual para que a própria reversão
 * possa ser desfeita. Retorna { restoredFrom, version }.
 */
function restoreVersion(id, options = {}) {
  const target = getVersion(id);
  if (!target) {
    const err = new Error('Versão não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }

  snapshotCurrent({ source: 'pre-restore', note: `Antes de restaurar ${id}` });
  const { version } = savePrompt(target.content, {
    source: 'restore',
    note: options.note || `Restaurado da versão v${target.seq || '?'} de ${new Date(target.createdAt).toLocaleString('pt-BR')}`,
    force: true,
  });

  logInfo(`[prompt-history] Prompt restaurado de ${id} (nova versão ${version.id})`);
  return { restoredFrom: target.id, restoredSeq: target.seq, restoredAt: target.createdAt, version };
}

module.exports = {
  PROMPT_FILE,
  HISTORY_DIR,
  MAX_VERSIONS,
  sha256,
  readPrompt,
  listVersions,
  getVersion,
  recordVersion,
  snapshotCurrent,
  savePrompt,
  restoreVersion,
};