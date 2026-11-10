const axios = require('axios');
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'evolution.log');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function logError(message, payload) {
  ensureLogsDir();
  const timestamp = new Date().toISOString();
  const sanitized = payload ? JSON.stringify(payload).replace(/(\d{2})\d+(\d{4})/g, '$1*****$2') : '';
  const line = `[${timestamp}] ERROR: ${message} ${sanitized}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    console.error('Failed to write evolution log:', line);
  }
}

function getBaseUrl() {
  const url = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
  const instance = process.env.EVOLUTION_INSTANCE_NAME || 'pousada-instance';
  // Evolution API v2.3.7 endpoint format: /message/sendText/{instance}
  return `${url}/message`;
}

function getInstanceName() {
  return process.env.EVOLUTION_INSTANCE_NAME || 'pousada-instance';
}

function getHeaders() {
  return {
    'apikey': process.env.EVOLUTION_API_KEY || '',
    'Content-Type': 'application/json',
  };
}

function getTimeout() {
  return parseInt(process.env.EVOLUTION_TIMEOUT_MS || '10000', 10);
}

async function sendText(phoneNumber, text) {
  console.log(`[evolution] sendText called`, JSON.stringify({ phoneNumber, text: text.substring(0, 100) }));
  try {
    const response = await axios.post(
      `${getBaseUrl()}/sendText/${getInstanceName()}`,
      {
        number: phoneNumber,
        text: text,
      },
      {
        headers: getHeaders(),
        timeout: getTimeout(),
      }
    );
    console.log(`[evolution] sendText success`, JSON.stringify({ phoneNumber, status: response.status }));
    return { success: true, data: response.data };
  } catch (error) {
    const message = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`[evolution] sendText failed`, JSON.stringify({ phoneNumber, error: message, response: error.response?.data }));
    logError(`sendText failed for ${phoneNumber}: ${message}`, { phoneNumber, text });
    return { success: false, error: message };
  }
}

async function sendMedia(phoneNumber, filePath, caption) {
  try {
    // Evolution API sendMedia expects a base64 or URL; for local files we read and encode
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', '..', filePath);

    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: `File not found: ${absolutePath}` };
    }

    const fileBuffer = fs.readFileSync(absolutePath);
    const base64 = fileBuffer.toString('base64');
    const mimeType = filePath.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    const fileName = path.basename(filePath);

    const response = await axios.post(
      `${getBaseUrl()}/sendMedia/${getInstanceName()}`,
      {
        number: phoneNumber,
        mediatype: 'document',
        mimetype: mimeType,
        caption: caption || '',
        file: base64,
        fileName: fileName,
      },
      {
        headers: getHeaders(),
        timeout: getTimeout(),
      }
    );
    return { success: true, data: response.data };
  } catch (error) {
    const message = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    logError(`sendMedia failed for ${phoneNumber}: ${message}`, { phoneNumber, filePath, caption });
    return { success: false, error: message };
  }
}

async function sendTyping(phoneNumber) {
  try {
    const baseUrl = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
    const instance = getInstanceName();
    const response = await axios.post(
      `${baseUrl}/chat/sendPresence/${instance}`,
      {
        number: phoneNumber,
        presence: 'composing',
        delay: 1500,
      },
      {
        headers: getHeaders(),
        timeout: getTimeout(),
      }
    );
    console.log(`[evolution] sendTyping success`, JSON.stringify({ phoneNumber }));
    return { success: true, data: response.data };
  } catch (error) {
    // Typing indicator é best-effort; não deve quebrar o fluxo se falhar
    const message = error.response
      ? `HTTP ${error.response.status}`
      : error.message;
    console.warn(`[evolution] sendTyping failed (non-blocking)`, JSON.stringify({ phoneNumber, error: message }));
    return { success: false, error: message };
  }
}

async function sendLocation(phoneNumber, latitude, longitude, name, address) {
  try {
    const response = await axios.post(
      `${getBaseUrl()}/sendLocation/${getInstanceName()}`,
      {
        number: phoneNumber,
        latitude: latitude,
        longitude: longitude,
        name: name || '',
        address: address || '',
      },
      {
        headers: getHeaders(),
        timeout: getTimeout(),
      }
    );
    console.log(`[evolution] sendLocation success`, JSON.stringify({ phoneNumber, name }));
    return { success: true, data: response.data };
  } catch (error) {
    const message = error.response
      ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`[evolution] sendLocation failed`, JSON.stringify({ phoneNumber, error: message }));
    logError(`sendLocation failed for ${phoneNumber}: ${message}`, { phoneNumber, latitude, longitude, name });
    return { success: false, error: message };
  }
}

module.exports = { sendText, sendMedia, sendTyping, sendLocation };