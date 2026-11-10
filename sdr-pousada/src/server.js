require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const express = require('express');
const { processMessage } = require('./orchestrator');
const { sendText, sendTyping, sendLocation } = require('./adapters/evolution');
const { info: logInfo, warn: logWarn, error: logError } = require('./utils/logger');
const iaSwitch = require('./utils/switch');
const { getSettings, updateSettings } = require('./utils/settings');
const { listHandoffs, resumeAI, triggerHandoff } = require('./utils/handoff');
const { clearHistory, appendMessage } = require('./utils/context');
const promptHistory = require('./utils/promptHistory');
const { parseLines: parseLogLines, summarize: summarizeLogs, CATEGORIES: LOG_CATEGORIES } = require('./utils/logParser');

const app = express();

// CORS middleware — permite requisições de qualquer origem (necessário quando o painel é acessado via IP/hostname diferente de localhost)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-admin-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '4000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
function isValidAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.trim()) return false;
  return (ADMIN_TOKEN && token === ADMIN_TOKEN) || (ADMIN_PASSWORD && token === ADMIN_PASSWORD);
}

if (!ADMIN_TOKEN) {
  logWarn('[server] ADMIN_TOKEN não configurado! Endpoints de admin (/admin/*) ficarão inacessíveis. Defina a variável de ambiente ADMIN_TOKEN.');
}

const IS_IN_CONTAINER = (process.platform !== 'win32' && require('fs').existsSync('/.dockerenv')) || process.env.DOCKER_CONTAINER === 'true';

// Debounce timers per phone number
const debounceTimers = new Map();

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin: enable IA explicitly
app.post('/admin/enable', (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  iaSwitch.enable();
  res.json({ enabled: true, message: 'IA ativada' });
});

// Admin: disable IA explicitly
app.post('/admin/disable', (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  iaSwitch.disable();
  res.json({ enabled: false, message: 'IA desativada' });
});

// Admin: toggle IA on/off (legacy)
app.post('/admin/toggle', (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const enabled = iaSwitch.toggle();
  res.json({
    enabled,
    message: enabled ? 'IA ativada' : 'IA desativada',
  });
});

// Admin: get current IA status
app.get('/admin/status', (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const state = iaSwitch.getState ? iaSwitch.getState() : { enabled: iaSwitch.isEnabled(), toggledAt: null };
  res.json({ enabled: !!state.enabled, toggledAt: state.toggledAt || null });
});

// Evolution API webhook receiver
const evolutionWebhookHandler = (req, res) => {
  // Kill switch: if IA is disabled, ack silently without processing
  if (!iaSwitch.isEnabled()) {
    return res.status(200).json({ received: true, ia_disabled: true });
  }

  // Always ack quickly so Evolution API doesn't retry
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    logInfo('[webhook] Received POST', JSON.stringify(body).substring(0, 500));

    // Extract message data from Evolution API payload format
    const data = body?.data;
    if (!data) {
      logWarn('[webhook] No data field in payload', JSON.stringify(body).substring(0, 200));
      return;
    }

    const key = data.key;
    const message = data.message;
    if (!key || !message) {
      logWarn('[webhook] Missing key or message', JSON.stringify(data).substring(0, 200));
      return;
    }

    // Skip messages sent by the bot itself
    if (key.fromMe) {
      logInfo('[webhook] Skipping own message (fromMe=true)');
      return;
    }

    // Extract phone number from remoteJid (format: 5511999999999@s.whatsapp.net)
    const remoteJid = key.remoteJid || '';
    const phoneNumber = remoteJid.split('@')[0];
    if (!phoneNumber) {
      logWarn('[webhook] No phoneNumber extracted', { remoteJid });
      return;
    }

    // Extract text content
    let text = '';
    if (message.conversation) {
      text = message.conversation;
    } else if (message.extendedTextMessage?.text) {
      text = message.extendedTextMessage.text;
    } else {
      // Non-text message (audio, image, etc.) — treat as audio hint
      text = '[audio]';
    }

    if (!text) {
      logWarn('[webhook] Empty text after extraction', { phoneNumber, messageType: Object.keys(message).join(',') });
      return;
    }

    logInfo('[webhook] Extracted text', { phoneNumber, text: text.substring(0, 100) });

    // Extract pushName (contact display name from Evolution API)
    const pushName = data.pushName || '';
    logInfo('[webhook] Extracted pushName', { phoneNumber, pushName });

    // Debounce: acumula as mensagens rápidas do mesmo número e processa uma única vez,
    // depois que o cliente parar de digitar (evita a IA responder no meio da digitação).
    if (debounceTimers.has(phoneNumber)) {
      clearTimeout(debounceTimers.get(phoneNumber).timer);
      debounceTimers.get(phoneNumber).parts.push(text);
    } else {
      debounceTimers.set(phoneNumber, { parts: [text] });
    }

    const pending = debounceTimers.get(phoneNumber);
    logInfo('[webhook] Scheduling handleMessage', { phoneNumber, pendingParts: pending.parts.length });
    pending.timer = setTimeout(async () => {
      const batched = debounceTimers.get(phoneNumber);
      debounceTimers.delete(phoneNumber);
      if (!batched) return;
      await enqueueMessage(phoneNumber, batched.parts.join('\n'), pushName);
    }, getSettings().debounceMs);
  } catch (error) {
    logError('[webhook] Error processing payload', error.message);
  }
};

app.post('/webhook/evolution', evolutionWebhookHandler);
app.post('/webhook/whatsapp', evolutionWebhookHandler);

const LOCATION_PIN = { latitude: -22.8797, longitude: -42.0188, name: 'Casarão do Luar', address: 'Bairro da Passagem, Cabo Frio' };

// Envia o pin somente depois que a mensagem textual com endereço/diferenciais foi entregue.
async function sendLocationPin(phoneNumber) {
  try {
    logInfo('[handler] Sending location pin after contextual text', { phoneNumber });
    const result = await sendLocation(phoneNumber, LOCATION_PIN.latitude, LOCATION_PIN.longitude, LOCATION_PIN.name, LOCATION_PIN.address);
    if (!result || result.success !== true) {
      logWarn('[handler] sendLocation failed', { phoneNumber, error: result && result.error ? result.error : 'Unknown Evolution API failure' });
      return;
    }
    // Marcador explícito só após confirmação real da Evolution API.
    appendMessage(phoneNumber, 'assistant', '[LOCATION_SENT]');
  } catch (error) {
    logWarn('[handler] sendLocation failed', { phoneNumber, error: error.message });
  }
}

// Fila por telefone: garante que o mesmo cliente seja atendido em série (uma mensagem por vez),
// evitando respostas cruzadas quando a IA demora e o cliente manda outra mensagem.
const conversationQueues = new Map();

function enqueueMessage(phoneNumber, text, pushName) {
  const previous = conversationQueues.get(phoneNumber) || Promise.resolve();
  const next = previous
    .then(() => handleMessage(phoneNumber, text, pushName))
    .catch((error) => logError(`[handler] Queue error for ${phoneNumber}`, error.message))
    .finally(() => {
      if (conversationQueues.get(phoneNumber) === next) conversationQueues.delete(phoneNumber);
    });
  conversationQueues.set(phoneNumber, next);
  return next;
}

async function handleMessage(phoneNumber, text, pushName) {
  try {
    logInfo('[handler] Starting processMessage', { phoneNumber, text: text.substring(0, 100), pushName });
    const result = await processMessage(phoneNumber, text, pushName);
    logInfo('[handler] processMessage returned', { phoneNumber, resultType: result.type, content: result.content?.substring(0, 100) });

    switch (result.type) {
      case 'reply':
        if (result.content) {
          // Envia status "escrevendo" e aguarda delay antes de enviar a resposta
          await sendTyping(phoneNumber);
          await new Promise((resolve) => setTimeout(resolve, getSettings().typingDelayMs));
          logInfo('[handler] Sending reply via Evolution', { phoneNumber, content: result.content.substring(0, 100) });
          const sent = await sendText(phoneNumber, result.content);
          if (!sent || sent.success !== true) {
            logWarn('[handler] sendText failed, skipping location pin', { phoneNumber, error: sent && sent.error ? sent.error : 'Unknown Evolution API failure' });
            break;
          }
          logInfo('[handler] Reply sent successfully', { phoneNumber });
          if (result.sendLocationAfterReply) {
            await sendLocationPin(phoneNumber);
          }
        }
        break;

      case 'multi_reply':
        if (Array.isArray(result.contents)) {
          for (let i = 0; i < result.contents.length; i++) {
            const msg = result.contents[i];
            if (!msg) continue;
            await sendTyping(phoneNumber);
            // Delay maior entre mensagens divididas para parecer digitação humana
            const settings = getSettings();
            const interMessageDelay = i === 0 ? settings.typingDelayMs : settings.interMessageDelayMs;
            if (interMessageDelay > 0) {
              await new Promise((resolve) => setTimeout(resolve, interMessageDelay));
            }
            logInfo('[handler] Sending multi_reply part via Evolution', { phoneNumber, part: i + 1, total: result.contents.length, content: msg.substring(0, 100) });
            const sentPart = await sendText(phoneNumber, msg);
            if (!sentPart || sentPart.success !== true) {
              logWarn('[handler] multi_reply part failed, aborting remaining parts', { phoneNumber, part: i + 1 });
              break;
            }
            // O pin sai logo após o bloco que trouxe o contexto/endereço, nunca no meio dos blocos
            if (result.sendLocationAfterReply && i === 0) {
              await sendLocationPin(phoneNumber);
            }
          }
          logInfo('[handler] Multi-reply sent successfully', { phoneNumber, parts: result.contents.length });
        }
        break;

      case 'handoff':
        // Handoff triggered — specialist takes over manually
        logInfo(`[handoff] Triggered for ${phoneNumber.replace(/(\d{2})\d+(\d{4})/, '$1*****$2')}`);
        break;

      case 'silence':
        // Number is silenced — do nothing
        logInfo('[handler] Message silenced', { phoneNumber });
        break;

      default:
        logWarn(`[orchestrator] Unknown action type: ${result.type}`);
    }
  } catch (error) {
    logError(`[handler] Error handling message for ${phoneNumber}`, error.message);
  }
}

// Admin: force rebuild container (remote via SSH to VPS)
let rebuildInProgress = false;
const VPS_HOST = process.env.VPS_HOST || '85.31.60.226';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_DIR = process.env.VPS_DIR || '~/ia-sdr-pousada';

// Estado do último rebuild para polling assíncrono
let lastRebuildResult = null;

app.post('/admin/rebuild', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (rebuildInProgress) {
    return res.status(409).json({ error: 'Rebuild já em andamento' });
  }
  // Se estiver dentro do container, não tem acesso ao SSH/docker do host
  if (IS_IN_CONTAINER) {
    return res.status(500).json({ error: 'Rebuild indisponível dentro do container. Use o deploy.bat na sua máquina local.' });
  }
  // Verifica se o ssh está disponível
  try {
    execSync('ssh -V', { stdio: 'ignore' });
  } catch (_e) {
    return res.status(500).json({
      error: 'SSH não encontrado nesta máquina.',
      detail: 'O rebuild remoto precisa do SSH instalado e configurado com chave para a VPS.'
    });
  }
  rebuildInProgress = true;
  lastRebuildResult = null;
  logInfo('[admin] Rebuild remoto iniciado via painel (SSH → VPS)');
  const startTime = Date.now();
  // Responde IMEDIATAMENTE com 202 Accepted — o frontend faz polling via /admin/rebuild/status
  res.status(202).json({ message: 'Rebuild iniciado', status: 'in_progress' });

  // Rebuild remoto na VPS via SSH (assíncrono, sem segurar a conexão HTTP)
  const fullCmd = `ssh ${VPS_USER}@${VPS_HOST} "cd ${VPS_DIR} && docker compose up -d --build"`;
  exec(fullCmd, { cwd: process.cwd(), timeout: 600000 }, (err, stdout, stderr) => {
    rebuildInProgress = false;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    if (err) {
      logError('[admin] Rebuild remoto falhou', err.message);
      lastRebuildResult = { success: false, error: stderr || err.message, duration };
      return;
    }
    logInfo(`[admin] Rebuild remoto concluído em ${duration}s`);
    lastRebuildResult = { success: true, message: 'Rebuild concluído na VPS', duration, output: stdout.trim() };
  });
});

// Admin: get rebuild status (polling assíncrono)
app.get('/admin/rebuild/status', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (rebuildInProgress) {
    return res.json({ rebuilding: true });
  }
  if (lastRebuildResult) {
    const result = lastRebuildResult;
    lastRebuildResult = null; // limpa após leitura para não repetir
    return res.json({ rebuilding: false, ...result });
  }
  res.json({ rebuilding: false });
});

// Admin: clear conversation memory for a specific phone number
app.post('/admin/clear-memory', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { phoneNumber } = req.body || {};
  try {
    if (!phoneNumber) {
      // Limpar TODAS as conversas quando phoneNumber não é fornecido
      const Database = require('better-sqlite3');
      const DB_PATH = path.join(__dirname, '..', 'data', 'conversations.db');
      const database = new Database(DB_PATH);
      database.prepare('DELETE FROM conversations').run();
      database.close();
      // Limpar handoffs também
      const handoffPath = path.join(__dirname, '..', 'data', 'handoffs.json');
      if (require('fs').existsSync(handoffPath)) {
        require('fs').writeFileSync(handoffPath, '{}', 'utf-8');
      }
      logInfo('[admin] Todas as conversas e handoffs foram apagados via painel');
      return res.json({ ok: true, message: 'Todas as conversas foram apagadas.' });
    }
    if (typeof phoneNumber !== 'string' || !/^\d{10,15}$/.test(phoneNumber.replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'phoneNumber inválido. Use apenas dígitos (ex.: 5522997822626).' });
    }
    const cleaned = phoneNumber.replace(/\D/g, '');
    clearHistory(cleaned);
    logInfo(`[admin] Memória limpa para ${cleaned.replace(/(\d{2})\d+(\d{4})/, '$1*****$2')}`);
    res.json({ ok: true, phoneNumber: cleaned, message: 'Memória da conversa apagada com sucesso.' });
  } catch (err) {
    logError('[admin] Falha ao limpar memória', err.message);
    res.status(500).json({ error: 'Falha ao limpar memória.', detail: err.message });
  }
});

// Admin: temporizadores de conversa (debounce, digitação, delay humano)
app.get('/admin/settings', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ settings: getSettings() });
});

app.post('/admin/settings', (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const settings = updateSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (err) {
    logError('[admin] Falha ao salvar temporizadores', err.message);
    res.status(500).json({ error: 'Falha ao salvar temporizadores.' });
  }
});

// Admin: contatos em atendimento humano (IA silenciosa)
app.get('/admin/handoffs', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ handoffs: listHandoffs() });
});

// Admin: passar ou devolver a conversa entre humano e IA
app.post('/admin/handoffs', (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { phoneNumber, action } = req.body || {};
  const cleaned = String(phoneNumber || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(cleaned)) {
    return res.status(400).json({ error: 'phoneNumber inválido. Use apenas dígitos (ex.: 5522997822626).' });
  }
  if (action === 'resume') {
    resumeAI(cleaned);
    return res.json({ ok: true, phoneNumber: cleaned, humanTakeover: false });
  }
  if (action === 'handoff') {
    triggerHandoff(cleaned, 'manual_painel');
    return res.json({ ok: true, phoneNumber: cleaned, humanTakeover: true });
  }
  return res.status(400).json({ error: 'action deve ser "handoff" ou "resume"' });
});

// Admin: list all conversations (grouped by phone, with last message preview)
app.get('/admin/conversations', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const Database = require('better-sqlite3');
    const DB_PATH = path.join(__dirname, '..', 'data', 'conversations.db');
    const database = new Database(DB_PATH, { readonly: true });

    const rows = database.prepare(`
      SELECT
        phone_number,
        COUNT(*) as message_count,
        MAX(timestamp) as last_message_at,
        (SELECT content FROM conversations c2
         WHERE c2.phone_number = c1.phone_number
         ORDER BY timestamp DESC LIMIT 1) as last_message,
        (SELECT role FROM conversations c2
         WHERE c2.phone_number = c1.phone_number
         ORDER BY timestamp DESC LIMIT 1) as last_role
      FROM conversations c1
      GROUP BY phone_number
      ORDER BY last_message_at DESC
    `).all();

    database.close();
    // Marca quais contatos estão em atendimento humano para o painel exibir o selo e o botão de devolver
    const handoffPhones = new Set(listHandoffs().map(h => h.phone));
    res.json({ conversations: rows.map(r => ({ ...r, humanTakeover: handoffPhones.has(String(r.phone_number).replace(/\D/g, '')) })) });
  } catch (err) {
    logError('[admin] Failed to list conversations', err.message);
    res.status(500).json({ error: 'Falha ao listar conversas.', detail: err.message });
  }
});

// Admin: get full conversation history for a specific phone
app.get('/admin/conversations/:phone', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const phone = req.params.phone.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: 'phone inválido' });
  }
  try {
    const Database = require('better-sqlite3');
    const DB_PATH = path.join(__dirname, '..', 'data', 'conversations.db');
    const database = new Database(DB_PATH, { readonly: true });

    const messages = database.prepare(`
      SELECT role, content, timestamp
      FROM conversations
      WHERE phone_number = ?
      ORDER BY timestamp ASC
    `).all(phone);

    database.close();
    res.json({ phone, messages });
  } catch (err) {
    logError('[admin] Failed to get conversation', err.message);
    res.status(500).json({ error: 'Falha ao carregar conversa.', detail: err.message });
  }
});

// Editor de System Prompt em tempo real (via painel admin)
const SYSTEM_PROMPT_FILE = promptHistory.PROMPT_FILE;

// Editor de Funções em tempo real (via painel admin)
const FUNCTIONS_CONFIG_FILE = path.join(__dirname, '..', 'data', 'functions-config.json');

app.get('/admin/functions', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (fs.existsSync(FUNCTIONS_CONFIG_FILE)) {
      const content = fs.readFileSync(FUNCTIONS_CONFIG_FILE, 'utf-8');
      return res.json({ functions: JSON.parse(content), source: 'file' });
    }
    return res.json({ functions: [], source: 'empty' });
  } catch (err) {
    logError('[admin] Falha ao ler functions config:', err);
    return res.status(500).json({ error: 'Falha ao ler funções' });
  }
});

app.post('/admin/functions', (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { functions } = req.body || {};
  if (!Array.isArray(functions)) {
    return res.status(400).json({ error: 'Campo "functions" deve ser array' });
  }
  try {
    fs.mkdirSync(path.dirname(FUNCTIONS_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(FUNCTIONS_CONFIG_FILE, JSON.stringify(functions, null, 2), 'utf-8');
    logInfo('[admin] Functions config atualizada via painel (' + functions.length + ' itens)');
    return res.json({ ok: true, count: functions.length });
  } catch (err) {
    logError('[admin] Falha ao salvar functions config:', err);
    return res.status(500).json({ error: 'Falha ao salvar funções' });
  }
});

// Admin: get recent logs
app.get('/admin/logs', (req, res) => {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const logPath = path.join(__dirname, '..', 'logs', 'app.log');
    if (!require('fs').existsSync(logPath)) {
      return res.json({ logs: [] });
    }
    const content = require('fs').readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    // Return last 400 lines, sanitized
    const recent = lines.slice(-400).map(line => {
      // Mask phone numbers and tokens in logs for security
      return line.replace(/(\d{2})\d+(\d{4})/g, '$1*****$2')
                 .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***REDACTED***');
    });
    // Eventos legíveis para o painel (o campo `logs` continua para compatibilidade)
    const entries = parseLogLines(recent).slice(-300);
    res.json({ logs: recent, entries, summary: summarizeLogs(entries), categories: LOG_CATEGORIES });
  } catch (err) {
    logError('[admin] Failed to read logs', err.message);
    res.status(500).json({ error: 'Falha ao ler logs' });
  }
});

app.get('/admin/prompt', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
      const content = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf-8');
      return res.json({ prompt: content, source: 'file' });
    }
    // Fallback: retorna vazio se arquivo não existir (o orchestrator usa o default interno)
    return res.json({ prompt: '', source: 'default' });
  } catch (err) {
    logError('[admin] Falha ao ler prompt:', err);
    return res.status(500).json({ error: 'Falha ao ler prompt' });
  }
});

app.post('/admin/prompt', express.json({ limit: '1mb' }), (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { prompt, note } = req.body || {};
  if (typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Campo "prompt" deve ser string' });
  }
  try {
    const { version } = promptHistory.savePrompt(prompt, {
      source: 'admin',
      note: typeof note === 'string' ? note : '',
    });
    logInfo('[admin] System prompt atualizado via painel (' + prompt.length + ' chars, versão ' + version.id + ')');
    return res.json({ ok: true, length: prompt.length, version });
  } catch (err) {
    logError('[admin] Falha ao salvar prompt:', err);
    return res.status(500).json({ error: 'Falha ao salvar prompt' });
  }
});

// Histórico de versões do system prompt (para reversão)
app.get('/admin/prompt/history', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const current = promptHistory.readPrompt();
    const versions = promptHistory.listVersions();
    return res.json({
      versions,
      currentSha256: current === null ? null : promptHistory.sha256(current),
      currentLength: current === null ? 0 : current.length,
    });
  } catch (err) {
    logError('[admin] Falha ao listar histórico do prompt:', err);
    return res.status(500).json({ error: 'Falha ao listar histórico do prompt' });
  }
});

app.get('/admin/prompt/history/:id', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const version = promptHistory.getVersion(req.params.id);
    if (!version) {
      return res.status(404).json({ error: 'Versão não encontrada' });
    }
    return res.json({ version });
  } catch (err) {
    logError('[admin] Falha ao ler versão do prompt:', err);
    return res.status(500).json({ error: 'Falha ao ler versão do prompt' });
  }
});

app.post('/admin/prompt/restore', express.json({ limit: '1mb' }), (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { id } = req.body || {};
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ error: 'Campo "id" é obrigatório' });
  }
  try {
    const result = promptHistory.restoreVersion(id.trim());
    logInfo('[admin] Prompt restaurado para versão ' + result.restoredFrom + ' (nova versão ' + result.version.id + ')');
    return res.json({
      ok: true,
      restoredFrom: result.restoredFrom,
      restoredSeq: result.restoredSeq,
      restoredAt: result.restoredAt,
      version: result.version,
      length: result.version.length,
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Versão não encontrada' });
    }
    logError('[admin] Falha ao restaurar prompt:', err);
    return res.status(500).json({ error: 'Falha ao restaurar prompt' });
  }
});

// Admin panel (public page; endpoints still require token)
app.get('/admin.css', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.css'));
});

app.get('/favicon.svg', (_req, res) => {
  res.type('image/svg+xml').sendFile(path.join(__dirname, '..', 'public', 'favicon.svg'));
});

app.get('/apple-touch-icon.png', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'apple-touch-icon.png'));
});

// Navegador pede /favicon.ico por padrão mesmo com <link rel="icon">: evita 404 no log
app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  logError('[server] UNCAUGHT EXCEPTION - server kept alive', err?.stack || err);
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('[server] UNHANDLED REJECTION - server kept alive', reason?.stack || reason);
  console.error('[FATAL] unhandledRejection:', reason);
});

const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST;

// Garante que o prompt em vigor tenha ao menos uma versão no histórico.
try {
  const { created, version } = promptHistory.snapshotCurrent({ source: 'boot', note: 'Prompt em vigor no start do servidor' });
  if (created) logInfo(`[prompt-history] Versão inicial registrada: ${version.id}`);
} catch (err) {
  logWarn(`[prompt-history] Falha ao registrar prompt inicial: ${err.message}`);
}

app.listen(PORT, HOST, () => {
  logInfo(`[server] IA SDR Pousada running on port ${PORT}`);
  console.log(`[server] IA SDR Pousada running on port ${PORT}`);
  console.log(`[server] Health check: http://${DISPLAY_HOST}:${PORT}/health`);
  console.log(`[server] Admin panel: http://${DISPLAY_HOST}:${PORT}/admin`);
});