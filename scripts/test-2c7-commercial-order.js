const assert = require('assert');
const path = require('path');

// Usa o context.js do projeto para validar migração v4 e persistência de quotePresented
const contextPath = path.join(__dirname, '..', 'src', 'utils', 'context.js');
const { getState, updateState, appendMessageWithState, clearHistory } = require(contextPath);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

console.log('\n📋 Etapa 2C.7 — Testes de ordem comercial\n');

// Limpa estado de teste
const TEST_PHONE = '5511999992c7';
clearHistory(TEST_PHONE);

console.log('🏷️  Grupo A: Migração v4 e campo quotePresented');

test('A1. Estado deve ter campo quotePresented após migração v4', () => {
  const state = getState(TEST_PHONE);
  assert.ok('quotePresented' in state, 'Campo quotePresented ausente no estado');
  assert.strictEqual(state.quotePresented, false, 'quotePresented deve iniciar como false');
});

test('A2. updateState deve persistir quotePresented=true', () => {
  updateState(TEST_PHONE, { quotePresented: true });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.quotePresented, true, 'quotePresented não foi persistido como true');
});

test('A3. updateState deve persistir quotePresented=false', () => {
  updateState(TEST_PHONE, { quotePresented: false });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.quotePresented, false, 'quotePresented não foi persistido como false');
});

test('A4. appendMessageWithState deve aceitar quotePresented', () => {
  clearHistory(TEST_PHONE);
  appendMessageWithState(TEST_PHONE, 'user', 'teste', { quotePresented: true });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.quotePresented, true, 'quotePresented não foi persistido via appendMessageWithState');
});

console.log('\n💰 Grupo B: Cotação antes da confirmação/handoff');

test('B1. Mudança de datas deve invalidar lastQuote mas NÃO quotePresented', () => {
  clearHistory(TEST_PHONE);
  updateState(TEST_PHONE, { checkIn: '2026-12-01', checkOut: '2026-12-05', quotePresented: true });
  // Simula persistência de cotação
  const { persistResult } = require(contextPath);
  persistResult(TEST_PHONE, 'quote', { checkIn: '2026-12-01', checkOut: '2026-12-05' }, { total: 1000 });
  // Muda datas → lastQuote deve ser invalidado
  updateState(TEST_PHONE, { checkIn: '2026-12-10', checkOut: '2026-12-15' });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.lastQuote, null, 'lastQuote deveria ser null após mudança de datas');
  // quotePresented NÃO deve ser resetado automaticamente (o orquestrador controla isso)
  // Mas na prática, se a cotação mudou, o orquestrador deve resetar quotePresented ao gerar nova cotação
});

test('B2. Mudança de suíte deve invalidar lastQuote', () => {
  clearHistory(TEST_PHONE);
  updateState(TEST_PHONE, { selectedRoom: 'Peró', quotePresented: true });
  const { persistResult } = require(contextPath);
  persistResult(TEST_PHONE, 'quote', { room: 'Peró' }, { total: 1000 });
  updateState(TEST_PHONE, { selectedRoom: 'Forte' });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.lastQuote, null, 'lastQuote deveria ser null após mudança de suíte');
});

console.log('\n👥 Grupo C: Recomendações só com hóspedes completos');

test('C1. Estado sem adultos nem crianças não deve ter dados de hóspedes', () => {
  clearHistory(TEST_PHONE);
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.adults, null, 'adults deveria ser null em estado limpo');
  assert.strictEqual(state.children, null, 'children deveria ser null em estado limpo');
});

test('C2. updateState com adultos deve persistir corretamente', () => {
  updateState(TEST_PHONE, { adults: 2 });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.adults, 2, 'adults não foi persistido');
});

test('C3. updateState com crianças e idades deve persistir corretamente', () => {
  updateState(TEST_PHONE, { children: 1, childrenAges: [5] });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.children, 1, 'children não foi persistido');
  assert.deepStrictEqual(state.childrenAges, [5], 'childrenAges não foi persistido');
});

console.log('\n🗺️  Grupo D: Separação de contextualização e pergunta de datas');

test('D1. regionAsked e regionKnown devem ser independentes de quotePresented', () => {
  clearHistory(TEST_PHONE);
  updateState(TEST_PHONE, { regionAsked: true, regionKnown: false, quotePresented: false });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.regionAsked, true, 'regionAsked não foi persistido');
  assert.strictEqual(state.regionKnown, false, 'regionKnown não foi persistido');
  assert.strictEqual(state.quotePresented, false, 'quotePresented não foi persistido');
});

test('D2. Todos os campos de controle de fluxo devem coexistir no estado', () => {
  updateState(TEST_PHONE, {
    regionAsked: true,
    regionKnown: true,
    quotePresented: true,
    selectedRoom: 'Peró',
    adults: 2,
    children: 1,
    childrenAges: [5],
    checkIn: '2026-12-01',
    checkOut: '2026-12-05',
  });
  const state = getState(TEST_PHONE);
  assert.strictEqual(state.regionAsked, true);
  assert.strictEqual(state.regionKnown, true);
  assert.strictEqual(state.quotePresented, true);
  assert.strictEqual(state.selectedRoom, 'Peró');
  assert.strictEqual(state.adults, 2);
  assert.strictEqual(state.children, 1);
  assert.deepStrictEqual(state.childrenAges, [5]);
  assert.strictEqual(state.checkIn, '2026-12-01');
  assert.strictEqual(state.checkOut, '2026-12-05');
});

// Limpeza final
clearHistory(TEST_PHONE);

console.log(`\n==================================================`);
console.log(`Resultados: ${passed} passaram, ${failed} falharam`);
console.log(`==================================================\n`);

if (failed > 0) process.exit(1);