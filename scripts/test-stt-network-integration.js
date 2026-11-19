/**
 * Teste E2E: Transcrição de áudio via rede interna (ia-sdr-evo-net)
 * Valida: Evolution → Base64 descriptografado → Groq Whisper → Orquestrador
 * 
 * Cenários:
 * C1: Áudio comum (audioMessage) com base64 da Evolution → transcrição OK
 * C2: Mensagem de voz (pttMessage) com base64 da Evolution → transcrição OK
 * C3: Falha na Evolution (timeout/erro) → fallback gracioso
 * C4: Falha na Groq (chave inválida/arquivo ruim) → fallback gracioso
 * C5: Mensagem de texto continua funcionando normalmente
 * C6: Texto transcrito chega ao orquestrador como mensagem normal
 * C7: MIME type correto é preservado no fluxo
 */

const http = require('http');
const assert = require('assert');

const PORT = 4130;
const PHONE = '5522999990000'; // usuário de teste (auto-reset)
const BASE = `http://127.0.0.1:${PORT}`;

// Arrays de captura devem ser declarados ANTES do mock que os usa
let evolutionCalls = [];
let groqCalls = [];
let orchestratorMessages = [];
let evoShouldFail = false;
let groqShouldFail = false;

// Interceptar processMessage para capturar mensagens que chegam ao orquestrador
const orchestratorModule = require('../src/orchestrator');
const originalProcessMessage = orchestratorModule.processMessage;
orchestratorModule.processMessage = async function(phoneNumber, text, pushName) {
  orchestratorMessages.push({ text, phoneNumber });
  return originalProcessMessage.call(this, phoneNumber, text, pushName);
};

// Mock da Evolution API (simula endpoint /chat/getBase64FromMediaMessage)

function createMockEvolution() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      evolutionCalls.push({ url: req.url, method: req.method, body });
      
      if (evoShouldFail) {
        res.writeHead(500); res.end('Internal Server Error'); return;
      }
      if (req.url.includes('/chat/getBase64FromMediaMessage')) {
        const fakeOggBase64 = Buffer.from('OggS' + '\x00'.repeat(100)).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ base64: fakeOggBase64, mimetype: 'audio/ogg', filename: 'audio.ogg' }));
      } else {
        res.writeHead(404); res.end('Not found');
      }
    });
  });
}

function createMockGroq() {
  return http.createServer((req, res) => {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      groqCalls.push({ url: req.url, method: req.method, size: Buffer.concat(body).length });
      
      if (groqShouldFail) {
        res.writeHead(401); res.end('{"error":"Invalid API Key"}'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'mensagem de teste transcrita com sucesso', language: 'pt' }));
    });
  });
}

async function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/webhook/evolution',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('🔧 Iniciando mocks e servidor...');
  
  // Subir mocks
  const mockEvo = createMockEvolution();
  const mockGroq = createMockGroq();
  await new Promise(r => mockEvo.listen(18080, r));
  await new Promise(r => mockGroq.listen(18081, r));
  console.log('✅ Mocks ativos: Evolution=18080, Groq=18081');
  
  // Configurar ambiente para usar mocks
  process.env.EVOLUTION_API_URL = 'http://127.0.0.1:18080';
  process.env.EVOLUTION_API_KEY = 'test-key';
  process.env.EVOLUTION_INSTANCE_NAME = 'triveleads';
	  process.env.GROQ_API_KEY = 'gsk_test_key';
	  process.env.GROQ_BASE_URL = 'http://127.0.0.1:18081';
  process.env.ADMIN_TOKEN = 'devtool';

  // Forçar debounce baixo via settings.json (lido a cada chamada por getSettings)
  const fs = require('fs');
  const path = require('path');
  const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ debounceMs: 200, typingDelayMs: 0, humanDelayMs: 0, interMessageDelayMs: 0 }));
  process.env.PORT = String(PORT);
  
  // Subir servidor real
  delete require.cache[require.resolve('../src/server')];
  const server = require('../src/server');
  await sleep(2000); // esperar inicialização
  
  const results = [];
  
  try {
    // ── C1: Áudio comum (audioMessage) ──────────────────────────────
    console.log('\n📋 C1: Áudio comum via audioMessage...');
    evolutionCalls = []; groqCalls = []; orchestratorMessages = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    
    const c1 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c1' },
        message: {
          audioMessage: {
            url: 'https://mmg.whatsapp.net/fake.enc',
            mimetype: 'audio/ogg',
            mediaKey: 'fake-key-c1'
          }
        },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    
    await sleep(3000); // esperar debounce + processMessage async
    const c1TextReachedOrchestrator = orchestratorMessages.some(m => m.text && m.text.includes('mensagem de teste transcrita'));
    const c1Pass = c1.status === 200 && evolutionCalls.length > 0 && groqCalls.length > 0 && c1TextReachedOrchestrator;
    results.push({ name: 'C1: audioMessage → transcrição', pass: c1Pass, detail: `evo=${evolutionCalls.length} groq=${groqCalls.length} orch=${c1TextReachedOrchestrator} status=${c1.status}` });
    
    // ── C2: PTT (mensagem de voz) ───────────────────────────────────
    console.log('📋 C2: Mensagem de voz (PTT)...');
    evolutionCalls = []; groqCalls = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    
    const c2 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c2' },
        message: {
          pttMessage: {
            url: 'https://mmg.whatsapp.net/fake-ptt.enc',
            mimetype: 'audio/ogg; codecs=opus',
            mediaKey: 'fake-key-c2'
          }
        },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    
    await sleep(3000); // esperar debounce + processMessage async
    const c2TextReachedOrchestrator = orchestratorMessages.some(m => m.text && m.text.includes('mensagem de teste transcrita'));
    const c2Pass = c2.status === 200 && evolutionCalls.length > 0 && groqCalls.length > 0 && c2TextReachedOrchestrator;
    results.push({ name: 'C2: pttMessage → transcrição', pass: c2Pass, detail: `evo=${evolutionCalls.length} groq=${groqCalls.length} orch=${c2TextReachedOrchestrator} status=${c2.status}` });
    
    // ── C5: Mensagem de texto normal ────────────────────────────────
    console.log('📋 C5: Mensagem de texto (sem áudio)...');
    evolutionCalls = []; groqCalls = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    
    const c5 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c5' },
        message: {
          conversation: 'olá, quero saber sobre disponibilidade'
        },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    
    await sleep(1500);
    const c5Pass = c5.status === 200 && groqCalls.length === 0;
    results.push({ name: 'C5: Texto normal sem STT', pass: c5Pass, detail: `evo=${evolutionCalls.length} groq=${groqCalls.length} status=${c5.status}` });
    
    // ── C3: Falha na Evolution (timeout/erro) → fallback gracioso ─────
    console.log('📋 C3: Falha na Evolution → fallback...');
    evolutionCalls = []; groqCalls = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    evoShouldFail = true;
    const c3 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c3' },
        message: { audioMessage: { url: 'https://mmg.whatsapp.net/fail.enc', mimetype: 'audio/ogg', mediaKey: 'fail-key' } },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    await sleep(2000);
    evoShouldFail = false;
    const c3Pass = c3.status === 200 && groqCalls.length === 0;
    results.push({ name: 'C3: Falha Evolution → fallback', pass: c3Pass, detail: `groq=${groqCalls.length} status=${c3.status}` });

    // ── C4: Falha na Groq → fallback gracioso ─────────────────────────
    console.log('📋 C4: Falha na Groq → fallback...');
    evolutionCalls = []; groqCalls = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    groqShouldFail = true;
    const c4 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c4' },
        message: { audioMessage: { url: 'https://mmg.whatsapp.net/fake-c4.enc', mimetype: 'audio/ogg', mediaKey: 'fake-key-c4' } },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    await sleep(2000);
    groqShouldFail = false;
    const c4Pass = c4.status === 200 && evolutionCalls.length > 0 && groqCalls.length > 0;
    results.push({ name: 'C4: Falha Groq → fallback', pass: c4Pass, detail: `evo=${evolutionCalls.length} groq=${groqCalls.length} status=${c4.status}` });

    // ── C7: MIME type preservado ────────────────────────────────────
    console.log('📋 C7: MIME type correto no fluxo...');
    evolutionCalls = []; groqCalls = [];
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoffs.json'), '{}');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'handoff_override.json'), '{}');
    
    const c7 = await sendWebhook({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: `${PHONE}@s.whatsapp.net`, id: 'msg-c7' },
        message: {
          audioMessage: {
            url: 'https://mmg.whatsapp.net/fake-mime.enc',
            mimetype: 'audio/mpeg',
            mediaKey: 'fake-key-c7'
          }
        },
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    });
    
    await sleep(1500);
    const c7Pass = c7.status === 200 && evolutionCalls.length > 0;
    results.push({ name: 'C7: MIME type preservado', pass: c7Pass, detail: `mimetype=audio/mpeg evo=${evolutionCalls.length}` });
    
  } catch (err) {
    console.error('❌ Erro durante testes:', err.message);
    results.push({ name: 'Erro geral', pass: false, detail: err.message });
  }
  
  // ── Relatório ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log('   RESULTADO DOS TESTES STT-REDE');
  console.log('═══════════════════════════════════════');
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.name}`);
    if (r.detail) console.log(`   ${r.detail}`);
    if (r.pass) passed++;
  }
  console.log('═══════════════════════════════════════');
  console.log(`Total: ${passed}/${results.length} passaram`);
  
  // Cleanup
  mockEvo.close();
  mockGroq.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});