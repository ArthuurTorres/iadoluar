/*
 * Verificação da cotação: cálculo determinístico (tabela de diárias) e resposta
 * real no fluxo, com mocks da Evolution, da LLM e do HospedInn.
 * Roda com: node scripts/test-pricing.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const { calculateQuote, formatQuote, extractChildrenAges, formatBRL } = require('../src/utils/pricing');

const MOCK_PORT = 5997;
const SERVER_PORT = 5998;
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'ia_enabled.json');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FALHOU  ${name}: ${err.message}`);
  }
}

console.log('=== tabela de diárias ===');

check('casal em outubro paga 249,90 por noite', () => {
  const q = calculateQuote('2026-10-10', '2026-10-13', 2, []);
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.nights, 3);
  assert.strictEqual(q.extrasPerNight, 0);
  assert.strictEqual(Math.round(q.total * 100) / 100, 749.7);
});

check('dezembro cobra 299,90 por noite', () => {
  const q = calculateQuote('2026-12-05', '2026-12-10', 2, []);
  assert.strictEqual(Math.round(q.total * 100) / 100, 1499.5);
});

check('4 adultos pagam 2 hóspedes adicionais de 120', () => {
  const q = calculateQuote('2026-12-05', '2026-12-10', 4, []);
  assert.strictEqual(q.extrasPerNight, 240);
  assert.strictEqual(Math.round(q.total * 100) / 100, 2699.5);
});

check('criança de 6 anos paga 90 por noite', () => {
  const q = calculateQuote('2026-11-01', '2026-11-03', 2, [6]);
  assert.strictEqual(q.extrasPerNight, 90);
  assert.strictEqual(Math.round(q.total * 100) / 100, 679.8);
});

check('criança de 2 anos não paga', () => {
  const q = calculateQuote('2026-11-01', '2026-11-03', 2, [2]);
  assert.strictEqual(q.extrasPerNight, 0);
});

check('criança de 12 anos paga como adulto adicional', () => {
  const q = calculateQuote('2026-11-01', '2026-11-03', 2, [12]);
  assert.strictEqual(q.extrasPerNight, 120);
});

check('cada noite vale pela sua própria data (atravessa temporadas)', () => {
  const q = calculateQuote('2026-12-27', '2026-12-30', 2, []);
  assert.deepStrictEqual(q.nightlyPrices, [299.9, 499, 499]);
  assert.strictEqual(Math.round(q.total * 100) / 100, 1297.9);
  assert.strictEqual(q.distinctNightly.length, 2);
});

check('período fora da tabela não cota', () => {
  const q = calculateQuote('2027-09-01', '2027-09-03', 2, []);
  assert.strictEqual(q.ok, false);
  assert.strictEqual(q.reason, 'outside_table');
});

check('suíte menor que o grupo não é cotada', () => {
  const q = calculateQuote('2026-12-05', '2026-12-10', 4, [], { capacity: 2 });
  assert.strictEqual(q.ok, false);
  assert.strictEqual(q.reason, 'room_too_small');
});

check('suíte com capacidade exata cota normalmente', () => {
  const q = calculateQuote('2026-12-05', '2026-12-10', 4, [], { capacity: 4 });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(Math.round(q.total * 100) / 100, 2699.5);
});

check('datas inválidas não cotam', () => {
  assert.strictEqual(calculateQuote('2026-12-10', '2026-12-05', 2, []).ok, false);
});

console.log('\n=== idades e formatação ===');

check('extrai idades de lista ("5 e 8 anos")', () => {
  assert.deepStrictEqual(extractChildrenAges('tenho 2 crianças de 5 e 8 anos'), [5, 8]);
});

check('extrai idades de lista longa', () => {
  assert.deepStrictEqual(extractChildrenAges('crianças de 5, 8 e 10 anos'), [5, 8, 10]);
});

check('formata real com milhar', () => {
  assert.strictEqual(formatBRL(2699.5), 'R$ 2.699,50');
  assert.strictEqual(formatBRL(249.9), 'R$ 249,90');
});

check('cotação mostra casal e adicionais separados', () => {
  const q = calculateQuote('2026-12-05', '2026-12-10', 4, []);
  const text = formatQuote(q, { roomName: 'Peró', roomCapacity: 4, checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 4, childrenAges: [] });
  assert.ok(text.includes('Diária (casal): R$ 299,90'), 'diária do casal ausente');
  assert.ok(text.includes('Hóspedes adicionais: R$ 240,00'), 'adicionais ausentes');
  assert.ok(text.includes('Total (5 noites): R$ 2.699,50'), 'total ausente');
  assert.ok(text.includes('Não inclui café da manhã'), 'aviso de café ausente');
  assert.ok(text.includes('Peró'), 'suíte ausente');
});

console.log('\n=== fluxo de cotação com mocks ===');

let events = [];
let llmIndex = 0;
let availabilityCalls = 0;

const ROOM_TYPE_IDS = ['100', '101', '102', '103', '104', '105', '106', '107'];
const ROOM_NAMES = ['Conchas', 'Dunas', 'Japonês', 'Brava', 'Peró', 'Foguete', 'Siqueira', 'Forte'];
const ROOM_OCCUPANTS = [2, 3, 3, 3, 4, 6, 6, 10];

// Respostas da LLM na ordem em que são chamadas durante o cenário
const REPLIES = [
  'Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?',
  'Sabia que Cabo Frio tem águas cristalinas? Ficamos a 500 metros da Praia do Forte.\n\nNosso endereço é: Praça Bandeira, 10 - Passagem, Cabo Frio.',
  'Anotado, 4 adultos! Quais as datas de check-in e check-out?',
  'De nada! Fico à disposição.',
];

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

const mock = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.url.includes('/oauth/token')) return json({ access_token: 'mock-token', expires_in: 3600 });

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
    return json({ data: ROOM_NAMES.map((name, i) => ({ id: ROOM_TYPE_IDS[i], attributes: { title: name, occupants: ROOM_OCCUPANTS[i], code: i + 1 } })) });
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
      EVOLUTION_API_KEY: 'mock-key',
      EVOLUTION_INSTANCE_NAME: 'mock-instance',
      LLM_API_KEY: 'mock-key',
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

  const phone = '5522997000001';
  const { clearHistory } = require('../src/utils/context');
  const { resumeAI } = require('../src/utils/handoff');
  clearHistory(phone);
  resumeAI(phone);

  for (const msg of ['oi', 'Gostaria de ver disponibilidade', 'ainda nao', '4 adultos', '5 a 10 de dezembro']) {
    await webhook(phone, msg);
    await sleep(2500);
  }
  await sleep(2500);

  console.log('\neventos até a disponibilidade:');
  events.forEach((e, i) => console.log(`${i + 1}. ${e.slice(0, 150)}`));

  check('disponibilidade foi consultada no HospedInn', () => assert.ok(availabilityCalls > 0, 'nenhuma consulta'));
  check('suítes foram listadas após saber o número de hóspedes', () => assert.ok(events.some((e) => /wa\.me\/p\//.test(e)), 'nenhuma lista de suítes'));

  // Pedido de preço — deve sair cotação calculada, sem nova consulta e sem pin
  events = [];
  const availabilityBefore = availabilityCalls;
  await webhook(phone, 'e quanto fica?');
  await sleep(4000);

  console.log('\nresposta ao pedido de preço:');
  events.forEach((e, i) => console.log(`${i + 1}. ${e}`));

  const quoteTexts = events.filter((e) => e.startsWith('text:'));
  const all = quoteTexts.join(' ');

  check('cotação foi enviada ao cliente', () => assert.ok(quoteTexts.length > 0, 'nada enviado'));
  check('totais seguem a tabela (dezembro, 5 noites, 4 adultos)', () => {
    assert.ok(/Diária \(casal\): R\$ 299,90/.test(all), `diária do casal ausente em: ${all}`);
    assert.ok(/Hóspedes adicionais: R\$ 240,00/.test(all), `adicionais ausentes em: ${all}`);
    assert.ok(/Total \(5 noites\): R\$ 2\.699,50/.test(all), `total ausente em: ${all}`);
  });
  check('cotação avisa que não inclui café da manhã', () => assert.ok(/café da manhã/i.test(all)));
  check('cotação termina com uma pergunta', () => assert.ok(/achou da proposta/i.test(all)));
  check('cotação não reenvia o pin de localização', () => assert.strictEqual(events.filter((e) => e === 'location').length, 0));
  check('não repetiu consulta de disponibilidade para cotar', () => assert.strictEqual(availabilityCalls, availabilityBefore));

  // Resumo de encaminhamento precisa trazer o valor total (mesma conta da cotação)
  events = [];
  await webhook(phone, 'sim');
  await sleep(4000);

  console.log('\nresumo de encaminhamento:');
  events.forEach((e, i) => console.log(`${i + 1}. ${e}`));

  const summaryAll = events.filter((e) => e.startsWith('text:')).join(' ');
  check('resumo mostra o valor total da estadia', () => {
    assert.ok(/Valor total: R\$ 2\.699,50/.test(summaryAll), `valor ausente em: ${summaryAll}`);
  });
  check('resumo mostra a suíte escolhida', () => assert.ok(/Suíte: Peró/.test(summaryAll)));
  check('resumo pergunta se pode encaminhar', () => assert.ok(/Posso encaminhar/i.test(summaryAll)));

  // Criança citada sem idade: não pode cotar valor subestimado, tem que perguntar a idade
  events = [];
  const childPhone = '5522997000002';
  clearHistory(childPhone);
  resumeAI(childPhone);
  for (const msg of ['oi', 'Somos 2 adultos e 2 criancas', '5 a 10 de dezembro']) {
    await webhook(childPhone, msg);
    await sleep(2500);
  }
  events = [];
  await webhook(childPhone, 'e quanto fica?');
  await sleep(4000);

  console.log('\ncotação pedida com criança sem idade:');
  events.forEach((e, i) => console.log(`${i + 1}. ${e}`));

  const childAll = events.filter((e) => e.startsWith('text:')).join(' ');
  check('não cotou valor sem a idade da criança', () => {
    assert.ok(!/Total \(\d+ noites\): R\$/.test(childAll), `cotou valor com idade desconhecida: ${childAll}`);
  });
  check('pediu a idade de cada criança', () => assert.ok(/qual a idade de cada crian/i.test(childAll), `não pediu idade em: ${childAll}`));

  server.kill();
  mock.close();

  if (failures > 0) {
    console.log('\n--- log do servidor (filtrado) ---');
    console.log(serverLog.split('\n').filter((l) => /quote|location|error|guests unknown/i.test(l)).slice(-25).join('\n'));
  }

  if (originalState !== null) fs.writeFileSync(STATE_FILE, originalState, 'utf-8');
  else fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: false }), 'utf-8');

  console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Erro no teste:', err.message);
  process.exit(1);
});