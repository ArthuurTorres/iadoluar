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
const { clearHistory, appendMessage, markQuotePresented } = require('./utils/context');
const promptHistory = require('./utils/promptHistory');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { parseLines: parseLogLines, summarize: summarizeLogs, CATEGORIES: LOG_CATEGORIES } = require('./utils/logParser');

// ── Descriptografia local via Baileys (fallback quando Evolution falha) ──
async function decryptAudioLocally(audioMsg) {
  try {
    if (!audioMsg.mediaKey || !audioMsg.directPath) {
      logWarn('[stt] Local decrypt skipped: missing mediaKey or directPath');
      return null;
    }
    const mediaKeyType = typeof audioMsg.mediaKey;
    const mediaKeyIsBuffer = Buffer.isBuffer(audioMsg.mediaKey);
    const mediaKeyLen = mediaKeyIsBuffer ? audioMsg.mediaKey.length : (Array.isArray(audioMsg.mediaKey) ? audioMsg.mediaKey.length : 0);
    const directPathType = typeof audioMsg.directPath;
    logInfo('[stt] Attempting local decryption via Baileys', {
      hasMediaKey: !!audioMsg.mediaKey,
      mediaKeyType,
      mediaKeyIsBuffer,
      mediaKeyLen,
      hasDirectPath: !!audioMsg.directPath,
      directPathType,
      mimetype: audioMsg.mimetype
    });
    const stream = await downloadContentFromMessage(
      { mediaKey: audioMsg.mediaKey, directPath: audioMsg.directPath, url: audioMsg.url },
      'audio'
    );
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) {
      logWarn('[stt] Local decrypt returned empty buffer');
      return null;
    }
    logInfo('[stt] Local decryption succeeded', { bytes: buffer.length });
    return buffer.toString('base64');
  } catch (err) {
    logError('[stt] Local decryption failed', { error: err.message });
    return null;
  }
}

// ── Evolution API: obter mídia descriptografada ─────────────────────
async function getMediaFromEvolution(messageKey, instanceName) {
  const apiKey = process.env.EVOLUTION_API_KEY;
  // Força URL externa da FluxiXY; fallback interno só se variável estiver explicitamente vazia
  const baseUrl = (process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_URL.trim()) || 'https://api.fluxixy.com';
  if (!apiKey) {
    logWarn('[stt] EVOLUTION_API_KEY not configured, cannot fetch decrypted media');
    return null;
  }
  try {
    const url = `${baseUrl}/chat/getBase64FromMediaMessage/${instanceName}`;
    logInfo('[stt] Fetching decrypted media from Evolution', { instanceName, hasKey: !!messageKey });
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify({ key: messageKey, message: { audioMessage: true } })
    });
    if (!resp.ok) {
      logWarn('[stt] Evolution getMedia failed', { status: resp.status, url });
      return null;
    }
    const result = await resp.json();
    const b64 = result.base64 || result.message?.audioMessage?.base64 || result.message?.pttMessage?.base64;
    if (b64) {
      logInfo('[stt] Got decrypted media from Evolution', { base64Len: b64.length });
      return b64;
    }
    logWarn('[stt] Evolution response has no base64 field', { keys: Object.keys(result).join(',') });
    return null;
  } catch (err) {
    logError('[stt] Error fetching media from Evolution', { error: err.message });
    return null;
  }
}

// ── Transcrição via URL (fallback quando Evolution falha) ───────────
async function transcribeAudioByUrl(audioUrl, mimetype = 'audio/ogg') {
  // Usa Groq Whisper via URL (aceita OGG/Opus nativamente; OpenAI rejeita .enc do WhatsApp)
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    logWarn('[stt] GROQ_API_KEY não configurada para transcrição via URL');
    return null;
  }
  try {
    logInfo('[stt] Downloading audio from WhatsApp URL', { urlLen: audioUrl.length, mimetype });
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      logError('[stt] Failed to download audio from WhatsApp', { status: audioResp.status });
      return null;
    }
    const arrayBuffer = await audioResp.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    logInfo('[stt] Audio downloaded, sending to Groq Whisper', { bytes: arrayBuffer.byteLength });
    // Usa Groq explicitamente via parâmetro provider (sem manipular env global)
    const result = await transcribeAudioBase64(base64Data, mimetype, 'groq');
    return result;
  } catch (err) {
    logError('[stt] Error in URL-based transcription', { error: err.message });
    return null;
  }
}

// ── OpenAI Whisper STT ──────────────────────────────────────────────
async function transcribeAudioBase64(base64Data, mimetype = 'audio/ogg', provider = null) {
  const apiKey = (provider === 'groq' ? process.env.GROQ_API_KEY : null) || (provider === 'openai' ? process.env.OPENAI_API_KEY : null) || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;
  const useOpenAI = provider === 'openai' || (!provider && !!process.env.OPENAI_API_KEY);
  if (!apiKey) {
    logWarn('[stt] Nenhuma chave de STT configurada (OPENAI_API_KEY ou GROQ_API_KEY), pulando transcrição');
    return null;
  }
  try {
    const boundary = '----STTFormBoundary' + Date.now();
    const mimeMap = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a' };
    const baseMime = mimetype.split(';')[0].trim().toLowerCase();
    const ext = mimeMap[baseMime] || 'ogg';
    const filename = `audio.${ext}`;
    const model = useOpenAI ? 'whisper-1' : 'whisper-large-v3-turbo';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}--\r\n`);
    const audioBuffer = Buffer.from(base64Data, 'base64');
    const body = Buffer.concat([header, audioBuffer, footer]);
    const sttUrl = useOpenAI
      ? 'https://api.openai.com/v1/audio/transcriptions'
      : (process.env.GROQ_BASE_URL || 'https://api.groq.com') + '/openai/v1/audio/transcriptions';
    logInfo('[stt] Sending to STT provider', { provider: useOpenAI ? 'openai' : 'groq', filename, mimetype, audioBytes: audioBuffer.length });
    const resp = await fetch(sttUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    if (!resp.ok) {
      const errText = await resp.text();
      logError('[stt] STT API error', { provider: useOpenAI ? 'openai' : 'groq', status: resp.status, body: errText.substring(0, 200) });
      return null;
    }
    const result = await resp.json();
    const transcript = (result.text || '').trim();
    logInfo('[stt] Transcrição concluída', { chars: transcript.length, model: result.model, preview: transcript.substring(0, 80) });
    return transcript || null;
  } catch (err) {
    logError('[stt] Falha na transcrição', { error: err.message });
    return null;
  }
}

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
const evolutionWebhookHandler = async (req, res) => {
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
    } else if (message.audioMessage || message.pttMessage || message.ephemeralMessage?.message?.audioMessage || message.ephemeralMessage?.message?.pttMessage) {
      // Audio message — transcribe via STT (supports ephemeral messages)
      const audioMsg = message.audioMessage || message.pttMessage || message.ephemeralMessage?.message?.audioMessage || message.ephemeralMessage?.message?.pttMessage;
      const msgType = message.audioMessage ? 'audioMessage' : (message.pttMessage ? 'pttMessage' : 'ephemeralAudio');
      logInfo('[stt] Audio detected in webhook', { phoneNumber, msgType, hasBase64: !!audioMsg.base64, hasUrl: !!audioMsg.url, mimetype: audioMsg.mimetype });
      let base64Data = audioMsg.base64;
      const mimetype = audioMsg.mimetype || 'audio/ogg';
      // Se base64 não veio diretamente, tenta obter via endpoint da Evolution API (descriptografa o áudio)
      if (!base64Data) {
        const instanceName = body?.instance || data?.metadata?.instance || 'triveleads';
        const messageKey = data.key;
        if (messageKey) {
          logInfo('[stt] No inline base64, fetching from Evolution API', { phoneNumber, instanceName });
          base64Data = await getMediaFromEvolution(messageKey, instanceName);
        } else {
          logWarn('[stt] No messageKey available to fetch media', { phoneNumber });
        }
      }
      if (base64Data) {
        logInfo('[stt] Media obtained, starting transcription', { phoneNumber, mimetype, base64Len: base64Data.length });
        const transcript = await transcribeAudioBase64(base64Data, mimetype);
        if (transcript) {
          text = transcript;
          logInfo('[stt] Transcript ready for orchestrator', { phoneNumber, chars: transcript.length, preview: transcript.substring(0, 80) });
        } else {
          logWarn('[stt] Transcription returned empty, using fallback', { phoneNumber });
          text = '[audio não transcrito]';
        }
      } else {
        // Fallback 1: descriptografia local via Baileys (usa mediaKey + directPath do webhook)
        logInfo('[stt] Evolution failed, trying local Baileys decryption', { phoneNumber });
        base64Data = await decryptAudioLocally(audioMsg);
        if (base64Data) {
          logInfo('[stt] Local decrypt succeeded, starting transcription', { phoneNumber, base64Len: base64Data.length });
          const transcript = await transcribeAudioBase64(base64Data, mimetype);
          if (transcript) {
            text = transcript;
            logInfo('[stt] Transcript ready for orchestrator (local decrypt)', { phoneNumber, chars: transcript.length, preview: transcript.substring(0, 80) });
          } else {
            logWarn('[stt] Transcription after local decrypt returned empty', { phoneNumber });
            text = '[audio não transcrito]';
          }
        } else if (audioMsg.url) {
          // Fallback 2: URL direta (último recurso, geralmente falha por .enc)
          logInfo('[stt] Local decrypt failed, trying direct URL transcription', { phoneNumber, urlPresent: true });
          const transcript = await transcribeAudioByUrl(audioMsg.url, mimetype);
          if (transcript) {
            text = transcript;
            logInfo('[stt] URL transcription succeeded', { phoneNumber, chars: transcript.length, preview: transcript.substring(0, 80) });
          } else {
            logWarn('[stt] URL transcription also failed', { phoneNumber });
            text = '[audio não transcrito]';
          }
        } else {
          logWarn('[stt] Audio detected but no base64 obtained', { phoneNumber, msgType });
          text = '[audio sem base64]';
        }
      }
    } else {
      // Other non-text message (image, video, etc.) — only if not audio
      text = '[mídia]';
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
      try {
        const batched = debounceTimers.get(phoneNumber);
        debounceTimers.delete(phoneNumber);
        if (!batched) return;
        await enqueueMessage(phoneNumber, batched.parts.join('\n'), pushName);
      } catch (err) {
        logError('[webhook] Error in debounced handleMessage', err.message);
      }
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
          // Só agora o cliente viu a cotação: a flag nasce do envio confirmado,
          // nunca da geração. Falha de entrega mantém quotePresented = false.
          if (result.quoteGenerated) {
            markQuotePresented(phoneNumber);
          }
          if (result.sendLocationAfterReply) {
            await sendLocationPin(phoneNumber);
          }
        }
        break;

      case 'multi_reply':
        if (Array.isArray(result.contents)) {
          let allPartsSent = true;
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
              allPartsSent = false;
              break;
            }
            // O pin sai logo após o bloco que trouxe o contexto/endereço, nunca no meio dos blocos
            if (result.sendLocationAfterReply && i === 0) {
              await sendLocationPin(phoneNumber);
            }
          }
          if (!allPartsSent) break;
          logInfo('[handler] Multi-reply sent successfully', { phoneNumber, parts: result.contents.length });
          // A cotação pode ter saído como um dos blocos: só marca apresentada depois
          // que todos foram entregues. Falha no meio aborta e mantém a flag falsa.
          if (result.quoteGenerated) {
            markQuotePresented(phoneNumber);
          }
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
      database.prepare('DELETE FROM conversation_state').run();
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

// Admin: enviar mensagem humana direta para um hóspede
app.post('/admin/reply/:phone', async (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: 'phoneNumber inválido.' });
  }
  const { text } = req.body || {};
  const msg = String(text || '').trim();
  if (!msg) {
    return res.status(400).json({ error: 'text é obrigatório.' });
  }
  try {
    // Garante que a conversa está em modo humano enquanto o atendente responde
    triggerHandoff(phone, 'manual_painel');
    await sendText(phone, msg);
    // Persiste a mensagem do humano no histórico para aparecer no painel
    try {
      const Database = require('better-sqlite3');
      const DB_PATH = path.join(__dirname, '..', 'data', 'conversations.db');
      const db = new Database(DB_PATH);
      db.prepare('INSERT INTO conversations (phone_number, role, content, timestamp) VALUES (?, ?, ?, ?)').run(phone, 'assistant', msg, Date.now());
      db.close();
    } catch (dbErr) {
      logWarn('[admin-reply] Falha ao persistir mensagem humana', dbErr.message);
    }
    logInfo('[admin-reply] Mensagem enviada', { phone, chars: msg.length });
    res.json({ ok: true, phone, sent: true });
  } catch (err) {
    logError('[admin-reply] Falha ao enviar mensagem', err.message);
    res.status(500).json({ error: 'Falha ao enviar mensagem.', detail: err.message });
  }
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

// === LLM Configuration Endpoints ===
const llmConfig = require('./utils/llmConfig');

// GET /admin/llm/config — retorna config atual (sem chave API) + provedores suportados
app.get('/admin/llm/config', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const config = llmConfig.getLlmConfig();
    res.json({
      config,
      hasApiKey: llmConfig.hasApiKey(),
      providers: llmConfig.SUPPORTED_PROVIDERS,
      limits: llmConfig.LIMITS
    });
  } catch (err) {
    logError('[admin] Falha ao ler config LLM', err.message);
    res.status(500).json({ error: 'Falha ao ler configuração do LLM' });
  }
});

// POST /admin/llm/config — salva nova configuração com validação
app.post('/admin/llm/config', (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const body = req.body || {};
    const hasParam = ['provider', 'model', 'baseUrl', 'temperature', 'maxTokens']
      .some(k => body[k] !== undefined && body[k] !== null && body[k] !== '');
    if (!hasParam) {
      return res.status(400).json({ error: 'Nenhum parâmetro recebido. Envie Content-Type: application/json com os campos da configuração.' });
    }
    const saved = llmConfig.saveLlmConfig(body);
    logInfo('[admin] Configuração LLM atualizada via painel', { provider: saved.provider, model: saved.model });
    res.json({ ok: true, config: saved });
  } catch (err) {
    logError('[admin] Falha ao salvar config LLM', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/llm/test — testa configuração candidata sem salvar
app.post('/admin/llm/test', async (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'LLM_API_KEY não configurada no servidor' });
  }
  const validated = llmConfig.validateConfig(req.body || {});
  if (!validated) {
    return res.status(400).json({ error: 'Configuração inválida' });
  }
  try {
    const axios = require('axios');
    const probe = [{ role: 'user', content: 'Responda apenas: OK' }];
    let reply = '';
    if (llmConfig.getApiStyle(validated.provider) === 'anthropic') {
      const response = await axios.post(
        `${validated.baseUrl}/messages`,
        { model: validated.model, messages: probe, max_tokens: 10, temperature: 0 },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );
      reply = response.data.content?.[0]?.text || '';
    } else {
      const response = await axios.post(
        `${validated.baseUrl}/chat/completions`,
        { model: validated.model, messages: probe, max_tokens: 10, temperature: 0 },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      reply = response.data.choices?.[0]?.message?.content || '';
    }
    res.json({ ok: true, model: validated.model, reply: reply.substring(0, 100) });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).substring(0, 200)}` : err.message;
    logError('[admin] Teste LLM falhou', detail);
    res.status(400).json({ error: `Falha na conexão: ${detail}` });
  }
});

// GET /admin/llm/history — histórico de alterações (últimas 20)
app.get('/admin/llm/history', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    res.json({ history: llmConfig.getHistory() });
  } catch (err) {
    logError('[admin] Falha ao ler histórico LLM', err.message);
    res.status(500).json({ error: 'Falha ao ler histórico' });
  }
});

// POST /admin/llm/restore — restaura versão anterior pelo id
app.post('/admin/llm/restore', (req, res) => {
  const token = req.body?.token || req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { id } = req.body || {};
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ error: 'Campo "id" é obrigatório' });
  }
  try {
    const restored = llmConfig.restoreFromHistory(id.trim());
    if (!restored) {
      return res.status(404).json({ error: 'Versão não encontrada no histórico' });
    }
    logInfo('[admin] Configuração LLM restaurada via painel', { id, provider: restored.provider, model: restored.model });
    res.json({ ok: true, config: restored });
  } catch (err) {
    logError('[admin] Falha ao restaurar config LLM', err.message);
    res.status(500).json({ error: 'Falha ao restaurar configuração' });
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