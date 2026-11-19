#!/usr/bin/env node
'use strict';

/**
 * Teste E2E das correções de localização (pin em ambos os cenários) e persistência de datas.
 *
 * Falha 1: Pin deve ser enviado quando cliente conhece a região (forcePin=true ignora alreadySent).
 * Falha 2: Datas persistidas não devem ser perdidas quando mensagem seguinte não contém datas.
 *
 * Usa mocks HTTP de Evolution, LLM e HospedInn, como test-2c15-immediate-handoff.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { clearHistory } = require('../src/utils/context');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 5998;
const SERVER_PORT = 4114;
const STATE_FILE = path.join(ROOT, 'data', 'switch-state.json');
const HANDOFFS_FILE = path.join(ROOT, 'data', 'handoffs.json');
const PHONE = '5522997822626';

function clearHandoffState(phone) {
 try {
 const data = JSON.parse(fs.readFileSync(HANDOFFS_FILE, 'utf-8'));
 delete data[phone];
 fs.writeFileSync(HANDOFFS_FILE, JSON.stringify(data), 'utf-8');
 } catch {
 fs.writeFileSync(HANDOFFS_FILE, '{}', 'utf-8');
 }
}

const events = [];
let availabilityCalls = 0;
let llmIndex = 0;

// Respostas da LLM mock: saudação inicial e fallback genérico
const REPLIES = [
  'Oi! Sou da recepção do Casarão do Luar 😊 Você já conhece a região de Cabo Frio?',
  'Claro! Me conta como posso ajudar com a sua hospedagem.',
];

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.log(`❌ ${name} — ${e.message}`);
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

const mock = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.url.includes('/oauth/token')) return json({ access_token: 'tok', expires_in: 3600 });

  if (req.url.includes('/api/v3/availabilities')) {
    availabilityCalls += 1;
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    const checkIn = new Date(`${q.get('check_in')}T00:00:00Z`);
    const checkOut = new Date(`${q.get('check_out')}T00:00:00Z`);
    const nights = Math.max(1, Math.round((checkOut - checkIn) / 86400000));
    const rows = [];
    for (let d = 0; d < nights; d++) {
      const date = new Date(checkIn.getTime() + d * 86400000).toISOString().split('T')[0];
      ['901', '902', '903'].forEach((id) => rows.push({ attributes: { place_type_id: id, date, availability: 1 } }));
    }
    return json({ data: rows });
  }

  if (req.url.includes('/api/v3/rooms')) {
    return json({ data: [
      { attributes: { place_type_id: '901', title: 'Suite 1 - Conchas' } },
      { attributes: { place_type_id: '902', title: 'Suite 2 - Peró' } },
      { attributes: { place_type_id: '903', title: 'Suite 3 - Foguete' } },
    ] });
  }

  if (req.url.includes('/api/v3/room_types') || req.url.includes('/api/v3/place_types')) {
    return json({ data: [
      { id: '901', attributes: { title: 'Conchas', occupants: 2, capacity: 2 } },
      { id: '902', attributes: { title: 'Peró', occupants: 4, capacity: 4 } },
      { id: '903', attributes: { title: 'Foguete', occupants: 5, capacity: 5 } },
    ] });
  }

  if (req.url.includes('/chat/completions')) {
    const reply = REPLIES[Math.min(llmIndex, REPLIES.length - 1)];
    llmIndex += 1;
    return json({ choices: [{ message: { content: reply } }] });
  }

  if (req.url.includes('/sendText')) {
    let text = '';
    try { text = JSON.parse(body).text || ''; } catch { text = ''; }
    events.push({ type: 'text', text });
    return json({ key: { id: 'mock' } });
  }

  if (req.url.includes('/sendLocation')) {
    events.push({ type: 'location' });
    return json({ key: { id: 'mock' } });
  }

  return json({});
});

function webhook(phone, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      data: {
        key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
        message: { conversation: text },
        pushName: 'Teste Local',
      },
    });
    const req = http.request(
      { host: '127.0.0.1', port: SERVER_PORT, path: '/webhook/evolution', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Salvar estado original do switch
  let originalState = null;
  try { originalState = fs.readFileSync(STATE_FILE, 'utf-8'); } catch { originalState = null; }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: true, toggledAt: new Date().toISOString() }), 'utf-8');

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      EVOLUTION_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
      EVOLUTION_API_KEY: 'mock',
      EVOLUTION_INSTANCE_NAME: 'mock-instance',
      LLM_API_KEY: 'mock',
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      HUMAN_DELAY_MS: '0',
      TYPING_DELAY_MS: '0',
      INTER_MESSAGE_DELAY_MS: '0',
      DEBOUNCE_MS: '300',
      HOSPEDINN_AUTH_URL: `http://127.0.0.1:${MOCK_PORT}/oauth/token`,
      HOSPEDINN_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      HOSPEDINN_CLIENT_ID: 'mock-id',
      HOSPEDINN_CLIENT_SECRET: 'mock-secret',
      ADMIN_TOKEN: 'devtool',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  // Aguardar servidor iniciar
  await sleep(2000);

  const results = [];

  try {
    console.log('\n🧪 Teste de Localização e Persistência de Datas\n');

    // === TESTE FALHA 1: Pin após "conheço sim" ===
    events.length = 0;
    availabilityCalls = 0;
    llmIndex = 0;
    clearHandoffState(PHONE);
    clearHistory(PHONE);

    // Passo 1: Mensagem que dispara o gate de região (deve perguntar se conhece a região)
    await webhook(PHONE, 'tem vaga para janeiro?');
    await sleep(1500);

    // Passo 2: Cliente confirma que conhece a região (deve receber pin)
    // O gate exige CONFIRMATION_PATTERN, então usamos 'sim' isolado
    events.length = 0;
    await webhook(PHONE, 'sim');
    await sleep(2000);

    const locationEvents = events.filter(e => e.type === 'location');
    const textEvents = events.filter(e => e.type === 'text');
    const hasAddress = textEvents.some(e => e.text.includes('Praia do Forte') || e.text.includes('Casarão'));

    results.push(check('F1-A: Pin enviado após "conheço sim"', () => {
      if (locationEvents.length === 0) throw new Error('Nenhum sendLocation detectado');
    }));

    results.push(check('F1-B: Endereço textual na resposta após "conheço sim"', () => {
      if (!hasAddress) throw new Error('Endereço não encontrado na resposta');
    }));

    // === TESTE FALHA 2: Datas persistidas após "adultos somente" ===
    events.length = 0;
    availabilityCalls = 0;
    llmIndex = 0;
    clearHandoffState(PHONE);
    clearHistory(PHONE);

    // Resetar estado do telefone via API admin
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: SERVER_PORT, path: `/admin/state/${PHONE}`, method: 'DELETE',
          headers: { 'x-admin-token': 'devtool' } },
        (res) => { res.resume(); res.on('end', resolve); }
      );
      req.on('error', reject);
      req.end();
    });
    await sleep(500);

    // Passo 1: Mensagem com datas
    await webhook(PHONE, 'quero reservar de 5 a 10 de janeiro');
    await sleep(2000);

    // Passo 2: Resposta de hóspedes sem datas (deve preservar as datas já persistidas)
    events.length = 0;
    await webhook(PHONE, '2 adultos');
    await sleep(2000);

    // Verificar se o bot pediu datas novamente (não deveria)
    const askedDatesAgain = events.some(e =>
      e.type === 'text' && (e.text.includes('preciso saber as datas') || e.text.includes('informar as datas'))
    );

    results.push(check('F2-A: Bot NÃO pediu datas novamente após "adultos somente"', () => {
      if (askedDatesAgain) throw new Error('Bot pediu datas novamente mesmo com datas já persistidas');
    }));

    // Verificar se disponibilidade foi consultada (significa que datas estavam no estado)
    results.push(check('F2-B: Disponibilidade consultada após "adultos somente" (datas preservadas)', () => {
      if (availabilityCalls === 0) throw new Error('HospedInn não foi consultada — datas provavelmente perdidas');
    }));

  } finally {
    server.kill();
    mock.close();

    // Restaurar estado original
    if (originalState !== null) {
      fs.writeFileSync(STATE_FILE, originalState, 'utf-8');
    } else {
      try { fs.unlinkSync(STATE_FILE); } catch {}
    }
  }

  const passed = results.filter(Boolean).length;
  const failed = results.filter(r => !r).length;
  console.log(`\n==================================================`);
  console.log(`✅ ${passed} passaram | ❌ ${failed} falharam`);
  if (failed > 0) {
    console.log('\n--- SERVER LOGS (últimas 80 linhas) ---');
    console.log(serverLog.split('\n').slice(-80).join('\n'));
    console.log('--- END SERVER LOGS ---');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); try { mock.close(); } catch {} process.exit(1); });