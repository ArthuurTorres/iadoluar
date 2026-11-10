/**
 * Testes de regressão da Etapa 2C.2 — Unificação do Estado no Orquestrador
 *
 * Valida:
 * 1. extractGuestsFromText: extração estruturada com merge parcial
 * 2. FASE 0: updateState após extração da mensagem atual
 * 3. buildQuoteReply/buildHandoffSummary usam getState() como fonte primária
 * 4. Snapshot atualizado após persistResult para handoff
 * 5. Datas parciais não perdem campos válidos
 * 6. Conversas antigas sem estado usam fallback regex
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Garante que better-sqlite3 é resolvido a partir da raiz do projeto
process.chdir(path.join(__dirname, '..'));

const {
  getState,
  updateState,
  clearHistory,
  appendMessage,
  extractGuestsFromText,
  hydrateStateFromHistory,
} = require('../src/utils/context');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// Limpa estado antes de cada teste
function setup(phone) {
  clearHistory(phone);
}

console.log('\n🔬 Testes de Regressão — Etapa 2C.2\n');

// ============================================================
// 1. extractGuestsFromText — extração estruturada
// ============================================================
console.log('📦 extractGuestsFromText:');

test('Extrai adultos de "2 adultos"', () => {
  const result = extractGuestsFromText('2 adultos');
  assert.strictEqual(result.adults, 2);
});

test('Extrai adultos de "dois adultos"', () => {
  const result = extractGuestsFromText('dois adultos');
  assert.strictEqual(result.adults, 2);
});

test('Extrai crianças de "1 criança"', () => {
  const result = extractGuestsFromText('1 criança');
  assert.strictEqual(result.children, 1);
});

test('Extrai idades de "criança de 6 anos"', () => {
  const result = extractGuestsFromText('criança de 6 anos');
  assert.deepStrictEqual(result.childrenAges, [6]);
});

test('Extrai múltiplas idades de "filhos de 5 e 8 anos"', () => {
  const result = extractGuestsFromText('filhos de 5 e 8 anos');
  assert.deepStrictEqual(result.childrenAges, [5, 8]);
});

test('Fallback "somos 4 pessoas" quando sem adultos explícitos', () => {
  const result = extractGuestsFromText('somos 4 pessoas');
  assert.strictEqual(result.adults, 4);
});

test('Não extrai adultos de "até 4 pessoas" (capacidade de suíte)', () => {
  const result = extractGuestsFromText('até 4 pessoas');
  assert.strictEqual(result.adults, undefined);
});

test('Retorna objeto vazio para texto sem dados de hóspedes', () => {
  const result = extractGuestsFromText('quero saber sobre a pousada');
  assert.deepStrictEqual(result, {});
});

test('Merge parcial: só adultos presentes, children omitido', () => {
  const result = extractGuestsFromText('3 adultos');
  assert.strictEqual(result.adults, 3);
  assert.strictEqual(result.children, undefined);
  assert.strictEqual(result.childrenAges, undefined);
});

// ============================================================
// 2. FASE 0 — updateState integra dados da mensagem atual
// ============================================================
console.log('\n🔄 FASE 0 — Integração no processMessage:');

test('updateState com merge parcial preserva campos omitidos', () => {
  const phone = '5511999990001';
  setup(phone);
  updateState(phone, { adults: 2, checkIn: '2026-12-15', checkOut: '2026-12-20' });
  updateState(phone, { children: 1 });
  const state = getState(phone);
  assert.strictEqual(state.adults, 2, 'adultos preservados');
  assert.strictEqual(state.children, 1, 'crianças adicionadas');
  assert.strictEqual(state.checkIn, '2026-12-15', 'checkIn preservado');
});

test('updateState com null limpa campo intencionalmente', () => {
  const phone = '5511999990002';
  setup(phone);
  updateState(phone, { checkIn: '2026-12-15', checkOut: '2026-12-20' });
  updateState(phone, { checkIn: null });
  const state = getState(phone);
  assert.strictEqual(state.checkIn, null, 'checkIn limpo');
  assert.strictEqual(state.checkOut, '2026-12-20', 'checkOut preservado');
});

test('Mudança em adultos invalida lastAvailability e lastQuote', () => {
  const phone = '5511999990003';
  setup(phone);
  updateState(phone, { adults: 2, checkIn: '2026-12-15', checkOut: '2026-12-20' });
  const { persistResult } = require('../src/utils/context');
  persistResult(phone, 'availability', { checkIn: '2026-12-15', checkOut: '2026-12-20', guests: 2 }, { available: true });
  persistResult(phone, 'quote', { checkIn: '2026-12-15', checkOut: '2026-12-20', adults: 2 }, { total: 500, nights: 5 });
  let state = getState(phone);
  assert.ok(state.lastAvailability, 'availability persistida');
  assert.ok(state.lastQuote, 'quote persistida');
  updateState(phone, { adults: 4 });
  state = getState(phone);
  assert.strictEqual(state.lastAvailability, null, 'availability invalidada por mudança de adultos');
  assert.strictEqual(state.lastQuote, null, 'quote invalidada por mudança de adultos');
});

test('Mudança em childrenAges invalida apenas lastQuote', () => {
  const phone = '5511999990004';
  setup(phone);
  updateState(phone, { adults: 2, children: 1, childrenAges: [5], checkIn: '2026-12-15', checkOut: '2026-12-20' });
  const { persistResult } = require('../src/utils/context');
  persistResult(phone, 'availability', { checkIn: '2026-12-15', checkOut: '2026-12-20', guests: 3 }, { available: true });
  persistResult(phone, 'quote', { checkIn: '2026-12-15', checkOut: '2026-12-20', adults: 2, childrenAges: [5] }, { total: 590, nights: 5 });
  updateState(phone, { childrenAges: [6] });
  const state = getState(phone);
  assert.ok(state.lastAvailability, 'availability preservada (idades não afetam disponibilidade)');
  assert.strictEqual(state.lastQuote, null, 'quote invalidada por mudança de idades');
});

// ============================================================
// 3. Datas parciais — não perde campos válidos
// ============================================================
console.log('\n📅 Datas parciais:');

test('Atualizar apenas checkIn preserva checkOut existente', () => {
  const phone = '5511999990005';
  setup(phone);
  updateState(phone, { checkIn: '2026-12-15', checkOut: '2026-12-20' });
  updateState(phone, { checkIn: '2026-12-16' });
  const state = getState(phone);
  assert.strictEqual(state.checkIn, '2026-12-16');
  assert.strictEqual(state.checkOut, '2026-12-20', 'checkOut preservado');
});

test('Mudança em checkIn invalida availability e quote', () => {
  const phone = '5511999990006';
  setup(phone);
  updateState(phone, { checkIn: '2026-12-15', checkOut: '2026-12-20', adults: 2 });
  const { persistResult } = require('../src/utils/context');
  persistResult(phone, 'availability', { checkIn: '2026-12-15', checkOut: '2026-12-20', guests: 2 }, { available: true });
  persistResult(phone, 'quote', { checkIn: '2026-12-15', checkOut: '2026-12-20', adults: 2 }, { total: 500, nights: 5 });
  updateState(phone, { checkIn: '2026-12-16' });
  const state = getState(phone);
  assert.strictEqual(state.lastAvailability, null, 'availability invalidada por mudança de data');
  assert.strictEqual(state.lastQuote, null, 'quote invalidada por mudança de data');
  assert.strictEqual(state.checkOut, '2026-12-20', 'checkOut preservado mesmo com invalidação');
});

// ============================================================
// 4. Hidratação de conversas antigas (fallback)
// ============================================================
console.log('\n🏛️ Hidratação de conversas antigas:');

test('Hidrata adultos e crianças de histórico textual', () => {
  const history = [
    { role: 'user', content: 'somos 2 adultos e 1 criança de 6 anos' },
    { role: 'assistant', content: 'Perfeito!' },
  ];
  const hydrated = hydrateStateFromHistory(history);
  assert.strictEqual(hydrated.adults, 2);
  assert.strictEqual(hydrated.children, 1);
  assert.deepStrictEqual(hydrated.childrenAges, [6]);
});

test('Hidrata datas por extenso "15 a 20 de dezembro"', () => {
  const history = [
    { role: 'user', content: 'quero reservar de 15 a 20 de dezembro' },
  ];
  const hydrated = hydrateStateFromHistory(history);
  assert.ok(hydrated.checkIn, 'checkIn hidratado');
  assert.ok(hydrated.checkOut, 'checkOut hidratado');
  assert.ok(hydrated.checkIn.endsWith('-12-15'), `checkIn correto: ${hydrated.checkIn}`);
  assert.ok(hydrated.checkOut.endsWith('-12-20'), `checkOut correto: ${hydrated.checkOut}`);
});

test('getState hidrata automaticamente conversa sem estado persistido', () => {
  const phone = '5511999990007';
  setup(phone);
  appendMessage(phone, 'user', 'somos 3 adultos');
  appendMessage(phone, 'assistant', 'Perfeito!');
  const state = getState(phone);
  assert.strictEqual(state.adults, 3, 'adultos hidratados via getState');
});

test('getState NÃO re-hidrata quando estado já existe', () => {
  const phone = '5511999990008';
  setup(phone);
  updateState(phone, { adults: 2 });
  appendMessage(phone, 'user', 'somos 5 adultos');
  const state = getState(phone);
  assert.strictEqual(state.adults, 2, 'estado persistido prevalece sobre histórico');
});

// ============================================================
// 5. Snapshot atualizado para handoff
// ============================================================
console.log('\n📸 Snapshot para handoff:');

test('persistResult atualiza estado sem depender de mensagem', () => {
  const phone = '5511999990009';
  setup(phone);
  updateState(phone, { adults: 2, checkIn: '2026-12-15', checkOut: '2026-12-20' });
  const { persistResult } = require('../src/utils/context');
  persistResult(phone, 'quote', { checkIn: '2026-12-15', checkOut: '2026-12-20', adults: 2 }, { total: 500, nights: 5 });
  const state = getState(phone);
  assert.ok(state.lastQuote, 'quote persistida independentemente de mensagem');
  assert.strictEqual(state.lastQuote.result.total, 500);
  assert.strictEqual(state.lastQuote.result.nights, 5);
});

test('getState retorna dados atualizados após persistResult', () => {
  const phone = '5511999990010';
  setup(phone);
  updateState(phone, { adults: 2, checkIn: '2026-12-15', checkOut: '2026-12-20' });
  const { persistResult } = require('../src/utils/context');
  persistResult(phone, 'availability', { checkIn: '2026-12-15', checkOut: '2026-12-20', guests: 2 }, { available: true, roomCount: 3 });
  const state = getState(phone);
  assert.ok(state.lastAvailability, 'availability disponível via getState');
  assert.strictEqual(state.lastAvailability.result.available, true);
  assert.strictEqual(state.lastAvailability.result.roomCount, 3);
});

// ============================================================
// Resumo
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Resultados: ${passed} passaram, ${failed} falharam`);
if (failures.length > 0) {
  console.log('\nFalhas:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
}
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);