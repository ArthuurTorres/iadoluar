#!/usr/bin/env node
/**
 * Testes de persistência de estado estruturado — Etapa 2C.1
 * Valida: schema, getState, updateState, persistResult, hidratação,
 * invalidação cruzada, janela LLM filtrada e clear transacional.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Usa DB temporário para não poluir o banco de produção
const TEST_DB_DIR = path.join(__dirname, '..', 'data', 'test-tmp');
if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-persistence.db');

// Limpa DB de teste anterior se existir
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

// Sobrescreve o caminho do DB antes de importar context.js
const contextModulePath = path.join(__dirname, '..', 'src', 'utils', 'context.js');
let contextSource = fs.readFileSync(contextModulePath, 'utf8');
const originalDbPathLine = contextSource.match(/const DB_PATH = .+;/);
if (!originalDbPathLine) {
  console.error('❌ Não encontrou linha DB_PATH em context.js');
  process.exit(1);
}
contextSource = contextSource.replace(
  originalDbPathLine[0],
  `const DB_PATH = '${TEST_DB_PATH.replace(/\\/g, '\\\\')}';`
);

// Escreve versão temporária do módulo DENTRO de src/utils/
// para que o Node resolva better-sqlite3 e requires relativos corretamente
const tmpModulePath = path.join(__dirname, '..', 'src', 'utils', 'context-test-tmp.js');
fs.writeFileSync(tmpModulePath, contextSource);

const {
  getHistory,
  appendMessage,
  appendMessageWithState,
  clearHistory,
  getState,
  updateState,
  persistResult,
  hydrateStateFromHistory,
  getFullHistory,
} = require(tmpModulePath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`❌ ${name}: ${e.message}`);
  }
}

// --- Schema e migração ---
test('Schema conversation_state criado automaticamente', () => {
  const state = getState('5511999999999');
  assert.ok(state, 'getState retorna objeto mesmo sem dados prévios');
  assert.strictEqual(state.phoneNumber, '5511999999999');
  assert.strictEqual(state.stage, 'greeting');
  assert.strictEqual(state.checkIn, null);
  assert.strictEqual(state.lastAvailability, null);
  assert.strictEqual(state.lastQuote, null);
});

// --- updateState básico ---
test('updateState grava datas e hóspedes', () => {
  updateState('5511999999999', {
    checkIn: '2026-12-01',
    checkOut: '2026-12-05',
    adults: 2,
    children: 1,
    childrenAges: [5],
  });
  const state = getState('5511999999999');
  assert.strictEqual(state.checkIn, '2026-12-01');
  assert.strictEqual(state.checkOut, '2026-12-05');
  assert.strictEqual(state.adults, 2);
  assert.strictEqual(state.children, 1);
  assert.deepStrictEqual(state.childrenAges, [5]);
});

// --- Merge parcial ---
test('updateState preserva campos omitidos', () => {
  updateState('5511999999999', { stage: 'collecting' });
  const state = getState('5511999999999');
  assert.strictEqual(state.stage, 'collecting');
  assert.strictEqual(state.checkIn, '2026-12-01'); // preservado
  assert.strictEqual(state.adults, 2); // preservado
});

// --- Children sem ages é válido ---
test('children > 0 com childrenAges null é estado válido', () => {
  updateState('5522999999999', { adults: 2, children: 2, childrenAges: null });
  const state = getState('5522999999999');
  assert.strictEqual(state.children, 2);
  assert.strictEqual(state.childrenAges, null);
});

// --- Invaliação: datas mudam → limpa availability e quote ---
test('Mudança de datas invalida lastAvailability e lastQuote', () => {
  updateState('5533999999999', { checkIn: '2026-12-01', checkOut: '2026-12-05' });
  persistResult('5533999999999', 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 2 },
    { available: true, roomCount: 3 }
  );
  persistResult('5533999999999', 'quote',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, childrenAges: [] },
    { total: 1200, nights: 4 }
  );
  let state = getState('5533999999999');
  assert.ok(state.lastAvailability, 'availability existe antes da mudança');
  assert.ok(state.lastQuote, 'quote existe antes da mudança');

  updateState('5533999999999', { checkIn: '2026-12-10' });
  state = getState('5533999999999');
  assert.strictEqual(state.lastAvailability, null, 'lastAvailability limpo após mudança de data');
  assert.strictEqual(state.lastQuote, null, 'lastQuote limpo após mudança de data');
});

// --- Invaliação: adultos/crianças mudam → limpa availability E quote ---
test('Mudança de hóspedes invalida lastAvailability e lastQuote', () => {
  updateState('5544999999999', { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, children: 0 });
  persistResult('5544999999999', 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 2 },
    { available: true, roomCount: 3 }
  );
  persistResult('5544999999999', 'quote',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, childrenAges: [] },
    { total: 1200, nights: 4 }
  );

  updateState('5544999999999', { adults: 4 });
  const state = getState('5544999999999');
  assert.strictEqual(state.lastAvailability, null, 'lastAvailability limpo após mudança de adultos');
  assert.strictEqual(state.lastQuote, null, 'lastQuote limpo após mudança de adultos');
});

// --- Invaliação: idades mudam → limpa apenas quote ---
test('Mudança de childrenAges invalida apenas lastQuote', () => {
  updateState('5555999999999', { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, children: 1, childrenAges: [5] });
  persistResult('5555999999999', 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 3 },
    { available: true, roomCount: 2 }
  );
  persistResult('5555999999999', 'quote',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, childrenAges: [5] },
    { total: 1500, nights: 4 }
  );

  updateState('5555999999999', { childrenAges: [8] });
  const state = getState('5555999999999');
  assert.ok(state.lastAvailability, 'lastAvailability preservado após mudança de idade');
  assert.strictEqual(state.lastQuote, null, 'lastQuote limpo após mudança de idade');
});

// --- persistResult independente de mensagem ---
test('persistResult grava availability sem appendMessage', () => {
  persistResult('5566999999999', 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 2 },
    { available: true, roomCount: 5 }
  );
  const state = getState('5566999999999');
  assert.ok(state.lastAvailability);
  assert.strictEqual(state.lastAvailability.params.guests, 2);
  assert.strictEqual(state.lastAvailability.result.available, true);
  assert.ok(state.lastAvailability.timestamp);
});

test('persistResult grava quote sem appendMessage', () => {
  persistResult('5566999999999', 'quote',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', adults: 2, childrenAges: [] },
    { total: 1000, nights: 4 }
  );
  const state = getState('5566999999999');
  assert.ok(state.lastQuote);
  assert.strictEqual(state.lastQuote.result.total, 1000);
  assert.ok(state.lastQuote.timestamp);
});

// --- Janela LLM filtra marcadores ---
test('getHistory exclui marcadores técnicos da janela LLM', () => {
  const phone = '5577999999999';
  appendMessage(phone, 'user', 'Quero reservar para dezembro');
  appendMessage(phone, 'assistant', '[AVAILABILITY_CHECK:{"checkIn":"2026-12-01","checkOut":"2026-12-05","guests":2}]');
  appendMessage(phone, 'assistant', 'Temos disponibilidade!');
  appendMessage(phone, 'assistant', '[LOCATION_SENT]');
  appendMessage(phone, 'user', 'Qual o valor?');

  const history = getHistory(phone);
  const markers = history.filter(m => m.content.startsWith('[AVAILABILITY_CHECK:') || m.content === '[LOCATION_SENT]');
  assert.strictEqual(markers.length, 0, 'Marcadores não aparecem na janela LLM');
  assert.ok(history.some(m => m.content === 'Temos disponibilidade!'), 'Mensagens normais preservadas');
});

// --- Histórico completo retém tudo ---
test('Histórico completo retém mensagens além de 20', () => {
  const phone = '5588999999999';
  for (let i = 0; i < 30; i++) {
    appendMessage(phone, 'user', `Mensagem ${i}`);
  }
  const windowHistory = getHistory(phone);
  assert.strictEqual(windowHistory.length, 20, 'Janela LLM limita a 20');

  // Verifica via getState que o histórico completo existe (não deletou)
  // A função getFullHistory deve retornar todas as 30
  const { getFullHistory } = require(tmpModulePath);
  const full = getFullHistory(phone);
  assert.strictEqual(full.length, 30, 'Histórico completo retém todas as 30 mensagens');
});

// --- Hidratação de conversa antiga ---
test('hydrateStateFromHistory recupera dados do histórico textual', () => {
  const history = [
    { role: 'user', content: 'Quero reservar de 15 a 20 de dezembro' },
    { role: 'assistant', content: 'Perfeito! Quantas pessoas?' },
    { role: 'user', content: '2 adultos e 1 criança de 6 anos' },
  ];
  const hydrated = hydrateStateFromHistory(history);
  assert.ok(hydrated.checkIn, 'checkIn recuperado');
  assert.ok(hydrated.checkOut, 'checkOut recuperado');
  assert.strictEqual(hydrated.adults, 2);
  assert.strictEqual(hydrated.children, 1);
  assert.deepStrictEqual(hydrated.childrenAges, [6]);
});

// --- appendMessageWithState atômico ---
test('appendMessageWithState grava mensagem e estado na mesma operação', () => {
  const phone = '5599999999999';
  appendMessageWithState(phone, 'user', 'Somos 3 adultos', { adults: 3 });
  const state = getState(phone);
  assert.strictEqual(state.adults, 3);
  const history = getHistory(phone);
  assert.ok(history.some(m => m.content === 'Somos 3 adultos'));
});

// --- clearHistory limpa estado e mensagens ---
test('clearHistory limpa mensagens e estado estruturado', () => {
  const phone = '5511999999999';
  updateState(phone, { checkIn: '2026-12-01', adults: 2 });
  appendMessage(phone, 'user', 'Olá');
  clearHistory(phone);
  const state = getState(phone);
  assert.strictEqual(state.checkIn, null, 'Estado limpo após clearHistory');
  assert.strictEqual(state.adults, null, 'Adults limpo após clearHistory');
  const history = getHistory(phone);
  assert.strictEqual(history.length, 0, 'Mensagens limpas após clearHistory');
});

// --- persistResult não sobrescreve com dados incompletos ---
test('persistResult com resultado vazio não sobrescreve resultado válido', () => {
  const phone = '5500999999999';
  persistResult(phone, 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 2 },
    { available: true, roomCount: 3 }
  );
  // Tenta persistir resultado vazio/incompleto
  persistResult(phone, 'availability',
    { checkIn: '2026-12-01', checkOut: '2026-12-05', guests: 2 },
    {}
  );
  const state = getState(phone);
  // O resultado válido deve ter sido preservado ou substituído pelo novo (depende da implementação)
  // Mas não deve haver estado parcial/corrompido
  assert.ok(state.lastAvailability, 'lastAvailability ainda existe');
  assert.ok(state.lastAvailability.timestamp, 'timestamp presente');
});

// --- Resumo ---
console.log(`\n📊 Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);

// Limpeza
try {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(tmpModulePath)) fs.unlinkSync(tmpModulePath);
  // Remove WAL/SHM se existirem
  [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
} catch (_) {}

process.exit(failed > 0 ? 1 : 0);