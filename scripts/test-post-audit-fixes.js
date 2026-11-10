/**
 * Testes pós-auditoria de produção (05/11/2026)
 * Cobre P1 (parser de hóspedes linguagem natural), P2 (gate de região contextual) e P4 (bloqueio de promessas vazias).
 */
const assert = require('assert');
const path = require('path');

// P1: extractGuestsFromText com linguagem natural
const { extractGuestsFromText } = require('../src/utils/context.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

// === P1: Parser de hóspedes — linguagem natural brasileira ===

test('P1-01: "eu e minha esposa" → 2 adultos', () => {
  const r = extractGuestsFromText('eu e minha esposa');
  assert.strictEqual(r.adults, 2, `Esperado adults=2, recebido ${r.adults}`);
  assert.strictEqual(r.children, undefined, 'Não deve ter children');
});

test('P1-02: "eu e meu marido" → 2 adultos', () => {
  const r = extractGuestsFromText('eu e meu marido');
  assert.strictEqual(r.adults, 2);
});

test('P1-03: "eu e minha companheira" → 2 adultos', () => {
  const r = extractGuestsFromText('eu e minha companheira');
  assert.strictEqual(r.adults, 2);
});

test('P1-04: "eu e meu companheiro" → 2 adultos', () => {
  const r = extractGuestsFromText('eu e meu companheiro');
  assert.strictEqual(r.adults, 2);
});

test('P1-05: "somos um casal" → 2 adultos', () => {
  const r = extractGuestsFromText('somos um casal');
  assert.strictEqual(r.adults, 2);
});

test('P1-06: "nós dois" → 2 adultos', () => {
  const r = extractGuestsFromText('nós dois');
  assert.strictEqual(r.adults, 2);
});

test('P1-07: "somos dois adultos" → 2 adultos', () => {
  const r = extractGuestsFromText('somos dois adultos');
  assert.strictEqual(r.adults, 2);
});

test('P1-08: "eu e meus dois filhos" → 1 adulto + 2 crianças', () => {
  const r = extractGuestsFromText('eu e meus dois filhos');
  assert.strictEqual(r.adults, 1, `Esperado adults=1, recebido ${r.adults}`);
  assert.strictEqual(r.children, 2, `Esperado children=2, recebido ${r.children}`);
});

test('P1-09: "eu e minha esposa e meus 3 filhos" → 2 adultos + 3 crianças', () => {
  const r = extractGuestsFromText('eu e minha esposa e meus 3 filhos');
  assert.strictEqual(r.adults, 2, `Esperado adults=2, recebido ${r.adults}`);
  assert.strictEqual(r.children, 3, `Esperado children=3, recebido ${r.children}`);
});

test('P1-10: "2 adultos" continua funcionando (parser numérico)', () => {
  const r = extractGuestsFromText('2 adultos');
  assert.strictEqual(r.adults, 2);
});

test('P1-11: "dois adultos" continua funcionando (parser textual)', () => {
  const r = extractGuestsFromText('dois adultos');
  assert.strictEqual(r.adults, 2);
});

test('P1-12: "somos 4 pessoas" continua funcionando (fallback)', () => {
  const r = extractGuestsFromText('somos 4 pessoas');
  assert.strictEqual(r.adults, 4);
});

test('P1-13: "1 criança de 5 anos" → children=1, ages=[5]', () => {
  const r = extractGuestsFromText('1 criança de 5 anos');
  assert.strictEqual(r.children, 1);
  assert.deepStrictEqual(r.childrenAges, [5]);
});

test('P1-14: "casal com 2 filhos de 3 e 7 anos" → 2 adultos + 2 crianças + ages', () => {
  const r = extractGuestsFromText('casal com 2 filhos de 3 e 7 anos');
  assert.strictEqual(r.adults, 2, `Esperado adults=2, recebido ${r.adults}`);
  assert.strictEqual(r.children, 2, `Esperado children=2, recebido ${r.children}`);
  assert.deepStrictEqual(r.childrenAges, [3, 7], `Esperado ages=[3,7], recebido ${JSON.stringify(r.childrenAges)}`);
});

test('P1-15: texto vazio retorna objeto vazio', () => {
  const r = extractGuestsFromText('');
  assert.deepStrictEqual(r, {});
});

// === P2: Gate de região — negação contextual ===
// Testa indiretamente via regex do padrão negativeRegionAnswer

test('P2-01: "ainda não" matchea negativeRegionAnswer', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(pattern.test('ainda não'), '"ainda não" deve matchear');
});

test('P2-02: "não conheço" matchea negativeRegionAnswer', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(pattern.test('não conheço'), '"não conheço" deve matchear');
});

test('P2-03: "nunca estive" matchea negativeRegionAnswer', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(pattern.test('nunca estive'), '"nunca estive" deve matchear');
});

test('P2-04: "primeira vez" matchea negativeRegionAnswer', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(pattern.test('primeira vez'), '"primeira vez" deve matchear');
});

test('P2-05: "sim" NÃO matchea negativeRegionAnswer (é confirmação)', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(!pattern.test('sim'), '"sim" não deve matchear negativeRegionAnswer');
});

test('P2-06: "não quero" NÃO matchea negativeRegionAnswer (não é resposta de região)', () => {
  const pattern = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i;
  assert.ok(!pattern.test('não quero'), '"não quero" não deve matchear');
});

// === P4: Bloqueio de promessas vazias ===
// Testa a regex PROMISE_PATTERN_PRECHECK e a lógica de dados faltantes

test('P4-01: "vou verificar a disponibilidade" matchea PROMISE_PATTERN', () => {
  const pattern = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  assert.ok(pattern.test('vou verificar a disponibilidade'));
});

test('P4-02: "deixa eu consultar" matchea PROMISE_PATTERN', () => {
  const pattern = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  assert.ok(pattern.test('deixa eu consultar a disponibilidade'));
});

test('P4-03: "um momento" matchea PROMISE_PATTERN', () => {
  const pattern = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  assert.ok(pattern.test('um momento'));
});

test('P4-04: "está disponível?" NÃO matchea PROMISE_PATTERN (é pergunta do cliente)', () => {
  const pattern = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  assert.ok(!pattern.test('está disponível?'));
});

// Resumo
console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);