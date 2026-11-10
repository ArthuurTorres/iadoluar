const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const APP_LOG_FILE = path.join(LOGS_DIR, 'app.log');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Sanitize PII from log messages — masks phone numbers and tokens.
 */
function sanitize(text) {
  if (typeof text !== 'string') {
    try {
      text = JSON.stringify(text);
    } catch {
      text = String(text);
    }
  }
  // Mask phone numbers: keep first 2 and last 4 digits
  text = text.replace(/(\d{2})\d+(\d{4})/g, '$1*****$2');
  // Mask Bearer tokens
  text = text.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***REDACTED***');
  // Mask client secrets / API keys in key=value or "key":"value" patterns
  text = text.replace(/(client_secret|api_key|apikey|secret|token)["']?\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]+/gi, '$1=***REDACTED***');
  return text;
}

function formatEntry(level, message, context) {
  const timestamp = new Date().toISOString();
  const ctx = context ? ` ${sanitize(context)}` : '';
  return `[${timestamp}] [${level}] ${sanitize(message)}${ctx}\n`;
}

function writeLog(level, message, context) {
  ensureLogsDir();
  const line = formatEntry(level, message, context);

  // Imprime no console (stdout/stderr) para Docker logs
  if (level === 'ERROR') {
    console.error(line.trim());
  } else if (level === 'WARN') {
    console.warn(line.trim());
  } else {
    console.log(line.trim());
  }

  // Escreve no arquivo (mantém comportamento existente)
  try {
    fs.appendFileSync(APP_LOG_FILE, line, 'utf-8');
  } catch (err) {
    console.error(`[logger] Failed to write log: ${err.message}`);
  }
}

function info(message, context) {
  writeLog('INFO', message, context);
}

function warn(message, context) {
  writeLog('WARN', message, context);
}

function error(message, context) {
  writeLog('ERROR', message, context);
}

module.exports = { info, warn, error };