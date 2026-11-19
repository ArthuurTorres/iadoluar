#!/usr/bin/env node
'use strict';

/**
 * Teste de ponta a ponta da Etapa 2C.15 — transferência imediata para o especialista.
 *
 * O MD muda o fim do fluxo comercial: depois de enviar o resumo de dados, o handoff
 * acontece NA MESMA resposta, sem perguntar "Está tudo correto?" e sem esperar "sim".
 * Verifica que:
 *   A1 - "Gostei" depois da cotação envia o resumo E aciona o handoff na mesma resposta;
 *   A2 - a IA fica silenciosa em seguida (o cliente não recebe mais respostas automáticas);
 *   A3 - pedir de novo não duplica o handoff (triggeredAt preservado, um resumo só);
 *   A4 - "Quero fechar" também transfere imediatamente;
 *   A5 - "Devolver para a IA" no painel reativa o atendimento.
 *
 * Usa mocks HTTP de Evolution, LLM e HospedInn, como test-2c12-flow-e2e.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 5997;
const SERVER_PORT = 4113;
const STATE_FILE = path.join(ROOT, 'data', 'switch-state.json');

const ROOM_TYPE_IDS = ['901', '902', '903'];
const ROOM_NAMES = ['Conchas', 'Peró', 'Foguete'];
const ROOM_OCCUPANTS = [2, 4, 5];

const events = [];
let availabilityCalls = 0;
let llmIndex = 0;
// A LLM só responde o que o orquestrador estruturado não decide (saudação).
const REPLIES = [
  'Oi! Sou da recepção do Casarão do Luar 😊 Como posso ajudar?',
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
      ROOM_TYPE_IDS.forEach((id) => rows.push({ attributes: { place_type_id: id, date, availability: 1 } }));
    }
    return json({ data: rows });
  }

  if (req.url.includes('/api/v3/rooms')) {
    return json({ data: ROOM_NAMES.map((name, i) => ({ attributes: { place_type_id: ROOM_TYPE_IDS[i], title: `Suite ${i + 1} - ${name}` } })) });
  }

  if (req.url.includes('/api/v3/room_types') || req.url.includes('/api/v3/place_types')) {
    return json({
      data: ROOM_NAMES.map((name, i) => ({
        id: ROOM_TYPE_IDS[i],
        attributes: { title: name, occupants: ROOM_OCCUPANTS[i], capacity: ROOM_OCCUPANTS[i] },
      })),
    });
  }

  if (req.url.includes('/chat/completions')) {
    const reply = REPLIES[Math.min(llmIndex, REPLIES.length - 1)];
    llmIndex += 1;
    return json({ choices: [{ message: { content: reply } }] });
  }

  if (req.url.includes('/sendText')) {
    let text = '';
    try { text = JSON.parse(body).text || ''; } catch { text = ''; }
    events.push(`text:${text.replace(/\s+/g, ' ')}`);
    return json({ key: { id: 'mock' } });
  }

  if (req.url.includes('/sendLocation')) {
    events.push('location');
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  await sleep(2500);

  const phone = '5522997000020';
  const { clearHistory, getState } = require('../src/utils/context');
  const { isHandoffTriggered, resumeAI, shouldSilence } = require('../src/utils/handoff');
  clearHistory(phone);
  resumeAI(phone);

  const quoteSignature = /🌙/;
  const summarySignature = /Em breve, nosso especialista/i;

  console.log('\n=== fluxo: disponibilidade, cotação, aprovação ===');
  for (const msg of ['oi', '4 adultos', '5 a 10 de janeiro', 'gostei da Foguete', 'e o valor?']) {
    await webhook(phone, msg);
    await sleep(2200);
  }
  await sleep(1500);

  assert.ok(availabilityCalls > 0, 'a disponibilidade não foi consultada');

  const quotesAntes = events.filter((e) => quoteSignature.test(e)).length;
  const summariesAntes = events.filter((e) => summarySignature.test(e)).length;
  assert.ok(quotesAntes > 0, 'a cotação não saiu antes da aprovação');

  // A1: o resumo e o handoff saem na MESMA resposta da aprovação.
  await webhook(phone, 'Gostei');
  await sleep(2500);

  const quotesDepois = events.filter((e) => quoteSignature.test(e)).length;
  const summariesDepois = events.filter((e) => summarySignature.test(e)).length;

  let ok = true;
  ok = check('A1 "Gostei" não repete a cotação', () => {
    assert.strictEqual(quotesDepois, quotesAntes, `cotação repetida (${quotesAntes} → ${quotesDepois})`);
  }) && ok;
  ok = check('A1 "Gostei" envia o resumo de dados', () => {
    assert.ok(summariesDepois > summariesAntes, 'nenhum resumo foi enviado');
  }) && ok;
  ok = check('A1 o handoff é acionado na mesma resposta, sem esperar "sim"', () => {
    assert.strictEqual(getState(phone).handoffConfirmed, true, 'handoffConfirmed não foi gravado');
    assert.strictEqual(isHandoffTriggered(phone), true, 'o handoff não foi registrado no arquivo');
  }) && ok;

  // A1b: o resumo usa as datas e o valor da cotação apresentada — nunca outras.
  ok = check('A1b o resumo traz as datas do período cotado (janeiro/2027)', () => {
    const resumo = events.filter((e) => summarySignature.test(e)).pop() || '';
    assert.ok(/05\/01\/2027/.test(resumo), `check-in errado no resumo: ${resumo.slice(0, 160)}`);
    assert.ok(/10\/01\/2027/.test(resumo), `check-out errado no resumo: ${resumo.slice(0, 160)}`);
    assert.ok(!/Invalid/.test(resumo), 'o resumo saiu com data inválida');
    assert.ok(!/2024/.test(resumo), 'o resumo trouxe data inventada (2024)');
  }) && ok;

  // A2: a IA fica silenciosa — nenhuma resposta nova para o cliente.
  ok = check('A2 a IA está silenciosa depois do handoff', () => {
    assert.strictEqual(shouldSilence(phone), true, 'shouldSilence deveria ser true após o handoff');
  }) && ok;

  const eventsAntesSilencio = events.length;
  await webhook(phone, 'oi?');
  await sleep(2200);
  ok = check('A2 nenhuma resposta automática após o handoff', () => {
    assert.strictEqual(events.length, eventsAntesSilencio, 'a IA respondeu depois de transferir');
  }) && ok;

  // A3: novo pedido não duplica o handoff nem o resumo.
  const { isOverrideActive } = require('../src/utils/handoff');
  const handoffsFile = path.join(ROOT, 'data', 'handoffs.json');
  const antesRepetir = JSON.parse(fs.readFileSync(handoffsFile, 'utf-8'))[phone];
  resumeAI(phone);
  await webhook(phone, 'Quero fechar');
  await sleep(2500);
  const depoisRepetir = JSON.parse(fs.readFileSync(handoffsFile, 'utf-8'))[phone];
  const summariesFinais = events.filter((e) => summarySignature.test(e)).length;

  ok = check('A3 repetir o pedido preserva o handoff original (sem duplicar)', () => {
    assert.strictEqual(depoisRepetir.triggeredAt, antesRepetir.triggeredAt, 'o handoff foi recriado');
  }) && ok;
  ok = check('A3 o handoff não gera resumo em loop', () => {
    assert.ok(summariesFinais - summariesAntes <= 2, `resumo repetido demais (${summariesFinais - summariesAntes} vezes)`);
  }) && ok;

  // A4: "Quero fechar" também transfere imediatamente.
  ok = check('A4 "Quero fechar" aciona o handoff na hora', () => {
    assert.strictEqual(isHandoffTriggered(phone), true, 'o handoff não foi registrado');
    assert.strictEqual(isOverrideActive(phone), false, 'o override deveria ter sido anulado pelo novo handoff');
  }) && ok;

  // A5: devolver para a IA reativa o atendimento.
  resumeAI(phone);
  const eventsAntesResume = events.length;
  await webhook(phone, 'oi, voltou?');
  await sleep(2500);
  ok = check('A5 após "Devolver para a IA" o contato volta a ser respondido', () => {
    assert.ok(events.length > eventsAntesResume, 'a IA continuou silenciada depois do resume');
  }) && ok;

  if (serverLog.includes('RangeError') || serverLog.includes('ReferenceError')) {
    console.log('\n⚠️  erro de execução no servidor:');
    const line = serverLog.split('\n').find((l) => /RangeError|ReferenceError/.test(l));
    console.log('  ' + line);
    ok = false;
  }

  clearHistory(phone);
  server.kill();
  mock.close();
  if (originalState !== null) fs.writeFileSync(STATE_FILE, originalState, 'utf-8');

  console.log(ok ? '\nTUDO OK' : '\nFALHOU');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); try { mock.close(); } catch {} process.exit(1); });