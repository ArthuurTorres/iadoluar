/*
 * Teste de integração do envio de localização e do formato em blocos.
 * Sobe um mock da Evolution API e da LLM, inicia o servidor real apontando para os mocks
 * e confere a ordem real das chamadas em cenários:
 *   1) cliente NÃO conhece a região -> texto de contexto, pin logo depois, pergunta em bloco separado
 *   2) cliente JÁ conhece a região   -> pin não sai (prompt: envio único, só quando não conhece)
 *   3) disponibilidade sem hóspedes  -> não lista suítes; pergunta quantas pessoas antes
 *   4) duas mensagens seguidas       -> processadas em série, sem respostas cruzadas
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 5997;
const SERVER_PORT = 5998;
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'ia_enabled.json');

const CONVERSATIONS = [
  {
    label: 'cliente pergunta localização explicitamente e recebe pin',
    phone: '5522990000001',
    messages: ['oi', 'onde fica a pousada?'],
    replies: [
      'Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?',
      'Estamos no Bairro da Passagem, a 500m da Praia do Forte. Posso te enviar o pin agora!',
    ],
    expectPin: true,
  },
  {
    label: 'cliente pergunta disponibilidade sem datas e recebe orientação',
    phone: '5522990000002',
    messages: ['oi', 'quero ver disponibilidade', 'não tenho data definida'],
    replies: [
      'Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?',
      'Claro, posso ajudar você a encontrar um período. Tem algum mês ou época do ano em mente, ou suas datas são flexíveis?',
    ],
    expectPin: false,
    expectDateHelp: true,
  },
  {
    label: 'disponibilidade sem número de hóspedes',
    phone: '5522990000003',
    messages: ['oi', 'quero ver disponibilidade', 'sim, já conheço', '5 a 10 de dezembro'],
    replies: [
      'Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?',
      'Que maravilha! Então já sabe que está num lugar especial.',
      'De nada!',
    ],
    expectPin: false,
    expectNoRoomList: true,
    expectGuestQuestion: true,
  },
  {
    label: 'cliente diz "4 pessoas" sem dizer adultos/crianças',
    phone: '5522990000005',
    messages: ['oi', 'quero ver disponibilidade', '4 pessoas', '5 a 10 de dezembro'],
    replies: ['Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?'],
    expectPin: false,
    expectChildComposition: true,
  },
  {
    label: 'LLM promete consultar com datas e hóspedes completos (sem pin intermediário)',
    phone: '5522990000006',
    messages: ['oi', 'quero ver disponibilidade', '2 adultos', '5 a 10 de dezembro'],
    replies: [
      'Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?',
      'Vou consultar a disponibilidade para você agora, um momento!',
    ],
    expectPin: false,
    expectPromiseResolved: true,
  },
  {
    label: 'cliente pede atendimento humano',
    phone: '5522990000004',
    messages: ['oi', 'quero falar com um atendente', 'oi, e aí?'],
    replies: ['Olá! Seja muito bem-vindo ao Casarão do Luar. Como posso ajudar você hoje?'],
    expectPin: false,
    expectHumanTakeover: true,
    expectTextCount: 2,
  },
];

let events = [];
let llmIndex = 0;
let currentReplies = [];

const ROOM_TYPE_IDS = ['100', '101', '102', '103', '104', '105', '106', '107'];
const ROOM_NAMES = ['Conchas', 'Dunas', 'Japonês', 'Brava', 'Peró', 'Foguete', 'Siqueira', 'Forte'];

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

const mock = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url.includes('/oauth/token')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }));
  }
  if (req.url.includes('/api/v3/availabilities')) {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    const checkIn = new Date(`${q.get('check_in')}T00:00:00Z`);
    const checkOut = new Date(`${q.get('check_out')}T00:00:00Z`);
    const nights = Math.max(1, Math.round((checkOut - checkIn) / 86400000));
    const rows = [];
    for (let d = 0; d < nights; d++) {
      const date = new Date(checkIn.getTime() + d * 86400000).toISOString().split('T')[0];
      ROOM_TYPE_IDS.forEach((id) => {
        rows.push({ attributes: { place_type_id: id, date, availability: 1 } });
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: rows }));
  }
  if (req.url.includes('/api/v3/rooms')) {
    const rows = ROOM_NAMES.map((name, i) => ({
      attributes: { place_type_id: ROOM_TYPE_IDS[i], title: name },
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: rows }));
  }
  if (req.url.includes('/chat/completions')) {
    const reply = currentReplies[Math.min(llmIndex, currentReplies.length - 1)];
    llmIndex += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  }
  if (req.url.includes('/sendText')) {
    let text = '';
    try { text = JSON.parse(body).text || ''; } catch { text = ''; }
    events.push(`text:${text.replace(/\s+/g, ' ')}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ key: { id: 'mock' } }));
  }
  if (req.url.includes('/sendLocation')) {
    events.push('location');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ key: { id: 'mock' } }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
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
const { isHandoffTriggered } = require('../src/utils/handoff');

async function runConversation(conversation) {
  const { clearHistory } = require('../src/utils/context');
  const { resumeAI } = require('../src/utils/handoff');
  clearHistory(conversation.phone);
  resumeAI(conversation.phone);
  events = [];
  llmIndex = 0;
  currentReplies = conversation.replies;

  for (const msg of conversation.messages) {
    await webhook(conversation.phone, msg);
    await sleep(6000);
  }
  await sleep(4000);
  clearHistory(conversation.phone);

  const order = events.filter((e) => e.startsWith('text:') || e === 'location');
  const locationIndexes = order.reduce((acc, e, i) => (e === 'location' ? [...acc, i] : acc), []);
  const contextTextIndex = order.findIndex((e) => e.startsWith('text:') && /Praça Bandeira|polo gastron/i.test(e));

  const checks = [
    ...(conversation.expectPin ? [['texto com endereço foi enviado', contextTextIndex >= 0]] : []),
    [
      conversation.expectPin ? 'pin enviado' : 'pin NÃO enviado',
      conversation.expectPin ? locationIndexes.length === 1 : locationIndexes.length === 0,
    ],
    ...(conversation.expectPin
      ? [['pin é o evento imediatamente seguinte ao texto com endereço', locationIndexes.length === 1 && locationIndexes[0] === contextTextIndex + 1]]
      : []),
    ...(conversation.expectPin
      ? [[
        'oferta de localização e endereço foram enviados em blocos separados',
        order.some((e) => e.startsWith('text:') && /posso enviar o pin/i.test(e)) &&
          order.some((e) => e.startsWith('text:') && /Praça Bandeira/i.test(e)) &&
          !order.some((e) => /posso enviar o pin[\s\S]*Praça Bandeira/i.test(e)), 
      ]]
      : []),
    ...(conversation.expectNoRoomList
      ? [['nenhuma suíte foi listada antes de saber o número de hóspedes', !order.some((e) => /wa\.me\/p\//.test(e))]]
      : []),
    ...(conversation.expectGuestQuestion
      ? [['IA perguntou quantas pessoas antes de listar', order.some((e) => /quantas pessoas vão se hospedar/i.test(e))]]
      : []),
    ...(conversation.expectChildComposition
      ? [
          ['IA confirmou se o grupo tem criança', order.some((e) => /todo de adultos ou tem crian/i.test(e))],
          ['nenhuma suíte foi listada antes da confirmação de crianças', !order.some((e) => /wa\.me\/p\//.test(e))],
        ]
      : []),
    ...(conversation.expectPromiseResolved
      ? [
          [
            'IA entregou a disponibilidade depois de prometer consultar',
            (() => {
              const texts = order.filter((e) => e.startsWith('text:'));
              const promiseIndex = texts.findIndex((e) => /vou consultar/i.test(e));
              const deliveredIndex = texts.findIndex((e) => /comportam seu grupo|op[çc][õo]es de su[íi]te/i.test(e));
              return promiseIndex >= 0 && deliveredIndex > promiseIndex;
            })(),
          ],
          [
            'lista de suítes não foi enviada em duplicidade',
            order.filter((e) => e.startsWith('text:') && /comportam seu grupo/i.test(e)).length <= 1,
          ],
        ]
      : []),
    ...(conversation.expectDateHelp
      ? [['IA ajudou cliente sem datas a escolher um período', order.some((e) => /encontrar um per[ií]odo|m[eê]s ou [eé]poca|datas s[aã]o flex[ií]veis/i.test(e))]]
      : []),
    ...(conversation.expectHumanTakeover
      ? [
          ['contato marcado como atendimento humano', isHandoffTriggered(conversation.phone)],
          ['IA ficou em silêncio após o handoff', order.filter((e) => e.startsWith('text:')).length === conversation.expectTextCount],
        ]
      : [['contato NÃO está em atendimento humano', !isHandoffTriggered(conversation.phone)]]),
    ...(conversation.expectHumanTakeover
      ? []
      : [['todas as respostas textuais enviadas', order.filter((e) => e.startsWith('text:')).length >= conversation.messages.length]]),
  ];

  console.log(`\n=== ${conversation.label} ===`);
  order.forEach((e, i) => console.log(`${i + 1}. ${e}`));
  let failed = false;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'OK ' : 'FALHA'} ${name}`);
    if (!ok) failed = true;
  }
  return { failed, order };
}

async function main() {
  let originalState = null;
  try { originalState = fs.readFileSync(STATE_FILE, 'utf-8'); } catch { originalState = null; }

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: true, toggledAt: new Date().toISOString() }), 'utf-8');

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  // Mock do HospedInn: sempre com as 8 suítes disponíveis
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

  let anyFailed = false;
  for (const conversation of CONVERSATIONS) {
    const result = await runConversation(conversation);
    if (result.failed) anyFailed = true;
  }

  server.kill();
  mock.close();

  if (anyFailed) {
    console.log('\n--- log do servidor (filtrado) ---');
    console.log(serverLog.split('\n').filter((l) => /location|Sending reply|error|guests unknown/i.test(l)).slice(-25).join('\n'));
  }

  if (originalState !== null) fs.writeFileSync(STATE_FILE, originalState, 'utf-8');
  else fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: false }), 'utf-8');

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Erro no teste:', err.message);
  process.exit(1);
});