#!/usr/bin/env node
'use strict';

/**
 * Teste de ponta a ponta da Etapa 2C.12 — fluxo real de atendimento.
 *
 * Reproduz o caso relatado (Casarão do Luar): o cliente informa as datas, recebe a
 * disponibilidade e pede o valor. Verifica que:
 *   F1 - as datas validadas são persistidas no estado (C1) — o ano em curso não pode
 *        ficar no passado depois de validateDates corrigir;
 *   F2 - a suíte citada é cotada e aparece na mensagem (C2 — string vs objeto);
 *   F3 - a cotação só é marcada como apresentada após a entrega real no WhatsApp;
 *   F4 - o handoff comercial não acontece antes do cliente ver a cotação;
 *   F5 - pedido explícito de atendimento humano passa imediatamente.
 *
 * Usa mocks HTTP de Evolution, LLM e HospedInn, como test-pricing.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 5998;
const SERVER_PORT = 4112;
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

  const phone = '5522997000012';
  const { clearHistory, getState } = require('../src/utils/context');
  const { resumeAI } = require('../src/utils/handoff');
  clearHistory(phone);
  resumeAI(phone);

  console.log('\n=== fluxo real: datas em janeiro, escolha da suíte, pedido de valor ===');
  // Sem o ano: o parser devolve o ano em curso (passado) e só validateDates corrige.
  // É o caso real relatado — com o ano explícito a FASE 0 já grava certo e o C1 não é exercitado.
  for (const msg of ['oi', '4 adultos', '5 a 10 de janeiro', 'gostei da Foguete', 'e o valor?']) {
    await webhook(phone, msg);
    await sleep(2200);
  }
  await sleep(2000);

  const state = getState(phone);

  events.forEach((e, i) => console.log(`${i + 1}. ${e.slice(0, 200)}`));

  let ok = true;

  ok = check('F1 disponibilidade consultada', () => assert.ok(availabilityCalls > 0, 'nenhuma consulta')) && ok;
  ok = check('F1 datas persistidas no estado (não null)', () => {
    assert.ok(state.checkIn, 'check_in está null');
    assert.ok(state.checkOut, 'check_out está null');
  }) && ok;
  ok = check('F1 datas persistidas estão no futuro (validateDates aplicado)', () => {
    const now = new Date().toISOString().split('T')[0];
    assert.ok(state.checkIn >= now, `check_in ${state.checkIn} está no passado (hoje ${now})`);
  }) && ok;
  ok = check('F1 estado preserva os 4 adultos', () => assert.strictEqual(state.adults, 4)) && ok;
  ok = check('F2 cotação apresentada ao cliente', () => {
    assert.ok(events.some((e) => /R\$/.test(e)), 'nenhuma mensagem com valor');
  }) && ok;
  ok = check('F2 mensagem da cotação nomeia a suíte cotada', () => {
    assert.ok(events.some((e) => /R\$/.test(e) && /Foguete/i.test(e)), 'cotação sem o nome da suíte');
  }) && ok;
  ok = check('F3 quotePresented marcado após a entrega real', () => {
    assert.strictEqual(state.quotePresented, true, 'quotePresented não foi marcado');
  }) && ok;
  ok = check('F3 lastQuote guarda a suíte e o total entregues', () => {
    assert.ok(state.lastQuote, 'lastQuote ausente');
    assert.strictEqual(state.lastQuote.params.room, 'Foguete');
    assert.ok(state.lastQuote.result.total > 0, 'total inválido');
  }) && ok;
  ok = check('F4 handoff não ocorreu antes do cliente ver a cotação', () => {
    assert.strictEqual(state.handoffConfirmed, false, 'handoff confirmado sem confirmação do cliente');
  }) && ok;

  // F6: aprovação do orçamento ("Gostei") leva ao resumo de confirmação,
  // sem repetir a cotação e sem handoff antes de o cliente confirmar o resumo.
  // Assinatura da cotação: a linha de noites. O resumo também tem "R$" (Valor total),
  // então contar por R$ confundiria cotação com resumo.
  const quoteSignature = /🌙/;
  const quotesAntes = events.filter((e) => quoteSignature.test(e)).length;
  const summariesAntes = events.filter((e) => /posso\s+encaminhar/i.test(e)).length;
  await webhook(phone, 'Gostei');
  await sleep(2200);
  const quotesDepois = events.filter((e) => quoteSignature.test(e)).length;
  const summariesDepois = events.filter((e) => /posso\s+encaminhar/i.test(e)).length;
  ok = check('F6 "Gostei" após a cotação não repete o orçamento', () => {
    assert.strictEqual(quotesDepois, quotesAntes, `cotação repetida (${quotesAntes} → ${quotesDepois})`);
  }) && ok;
  ok = check('F6 "Gostei" após a cotação leva ao resumo de confirmação', () => {
    assert.ok(summariesDepois > summariesAntes, 'nenhum resumo de confirmação foi enviado');
  }) && ok;
  ok = check('F6 handoff não ocorre antes de o cliente confirmar o resumo', () => {
    assert.strictEqual(getState(phone).handoffConfirmed, false, 'handoff disparado na aprovação');
  }) && ok;

  // F5: pedido explícito de humano deve passar na hora.
  const { isHandoffTriggered } = require('../src/utils/handoff');
  await webhook(phone, 'quero falar com um atendente humano');
  await sleep(2200);
  ok = check('F5 pedido explícito de humano dispara handoff imediato', () => {
    assert.strictEqual(isHandoffTriggered(phone), true, 'o handoff não foi registrado');
  }) && ok;

  // F7: "Devolver para a IA" no painel tem de reativar o atendimento. O registro de
  // handoff continua no histórico (é o override que libera), então a guarda de silêncio
  // não pode olhar só isHandoffTriggered — senão o contato fica mudo para sempre.
  resumeAI(phone);
  const eventsAntesResume = events.length;
  await webhook(phone, 'oi, voltou?');
  await sleep(2500);
  ok = check('F7 após "Devolver para a IA" o contato volta a ser respondido', () => {
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
