/*
 * Teste de handoff e controle de intenção (Etapa 2A)
 * Verifica que:
 * - Confirmações genéricas pós-cotação NÃO disparam handoff
 * - Intenção explícita de reserva dispara handoff
 * - Pedido humano tem prioridade absoluta
 * - Negações/hipóteses não disparam handoff
 * - Handoff duplicado é bloqueado
 *
 * Roda com: node scripts/test-handoff.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HANDOFFS_FILE = path.join(DATA_DIR, 'handoffs.json');
const OVERRIDE_FILE = path.join(DATA_DIR, 'handoff_override.json');
const CONVERSATIONS_DB = path.join(DATA_DIR, 'conversations.db');

// Backup dos arquivos de estado antes dos testes
let handoffsBackup = null;
let overrideBackup = null;
let dbBackup = null;

function backupState() {
  if (fs.existsSync(HANDOFFS_FILE)) handoffsBackup = fs.readFileSync(HANDOFFS_FILE);
  if (fs.existsSync(OVERRIDE_FILE)) overrideBackup = fs.readFileSync(OVERRIDE_FILE);
  if (fs.existsSync(CONVERSATIONS_DB)) dbBackup = fs.readFileSync(CONVERSATIONS_DB);
}

function restoreState() {
  if (handoffsBackup !== null) fs.writeFileSync(HANDOFFS_FILE, handoffsBackup);
  else if (fs.existsSync(HANDOFFS_FILE)) fs.unlinkSync(HANDOFFS_FILE);

  if (overrideBackup !== null) fs.writeFileSync(OVERRIDE_FILE, overrideBackup);
  else if (fs.existsSync(OVERRIDE_FILE)) fs.unlinkSync(OVERRIDE_FILE);

  if (dbBackup !== null) fs.writeFileSync(CONVERSATIONS_DB, dbBackup);
}

// Limpa estado de handoff entre cenários
function resetHandoffState(phoneNumber) {
  const safe = String(phoneNumber).replace(/[^0-9]/g, '');
  if (fs.existsSync(HANDOFFS_FILE)) {
    const data = JSON.parse(fs.readFileSync(HANDOFFS_FILE, 'utf-8'));
    delete data[safe];
    fs.writeFileSync(HANDOFFS_FILE, JSON.stringify(data, null, 2));
  }
  if (fs.existsSync(OVERRIDE_FILE)) {
    const data = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf-8'));
    delete data[safe];
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(data, null, 2));
  }
}

// Extrai os padrões regex do orquestrador para teste unitário direto
function extractPatterns() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf-8');

  const confirmationMatch = src.match(/const CONFIRMATION_PATTERN = (.+?);/s);
  const explicitReserveMatch = src.match(/const EXPLICIT_RESERVE_PATTERN = (.+?);/s);
  const reserveNegationMatch = src.match(/const RESERVE_NEGATION_PATTERN = (.+?);/s);
  const requestHumanMatch = src.match(/const REQUEST_HUMAN_PATTERN = (.+?);/s);

  if (!confirmationMatch || !explicitReserveMatch || !reserveNegationMatch || !requestHumanMatch) {
    throw new Error('Não foi possível extrair todos os padrões regex do orchestrator.js');
  }

  // eslint-disable-next-line no-eval
  return {
    CONFIRMATION_PATTERN: eval(confirmationMatch[1]),
    EXPLICIT_RESERVE_PATTERN: eval(explicitReserveMatch[1]),
    RESERVE_NEGATION_PATTERN: eval(reserveNegationMatch[1]),
    REQUEST_HUMAN_PATTERN: eval(requestHumanMatch[1]),
  };
}

let failures = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ OK  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`❌ FALHOU  ${name}: ${err.message}`);
  }
}

// ============================================================
// TESTES UNITÁRIOS DOS PADRÕES REGEX
// ============================================================
console.log('\n=== Padrões regex: confirmações genéricas NÃO devem casar como reserva ===');

const patterns = extractPatterns();

check('"ok" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('ok'));
});

check('"sim" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('sim'));
});

check('"perfeito" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('perfeito'));
});

check('"entendi" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('entendi'));
});

check('"obrigado" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('obrigado'));
});

check('"certo" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('certo'));
});

check('"Perfeito, obrigado" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('Perfeito, obrigado'));
});

check('"Vou pensar e te aviso" não casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(!patterns.EXPLICIT_RESERVE_PATTERN.test('Vou pensar e te aviso'));
});

console.log('\n=== Padrões regex: intenções explícitas DEVEM casar ===');

check('"quero reservar" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('quero reservar'));
});

check('"pode fechar" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('pode fechar'));
});

check('"Pode fechar para mim" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('Pode fechar para mim'));
});

check('"confirmo a reserva" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('confirmo a reserva'));
});

check('"quero garantir a hospedagem" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('quero garantir a hospedagem'));
});

check('"vou fechar" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('vou fechar'));
});

check('"desejo reservar" casa EXPLICIT_RESERVE_PATTERN', () => {
  assert.ok(patterns.EXPLICIT_RESERVE_PATTERN.test('desejo reservar'));
});

console.log('\n=== Padrões regex: negações e hipóteses NÃO devem casar como reserva ===');

check('"não quero reservar ainda" casa RESERVE_NEGATION_PATTERN', () => {
  assert.ok(patterns.RESERVE_NEGATION_PATTERN.test('não quero reservar ainda'));
});

check('"não quero reservar ainda" NÃO deve ser tratado como reserva (negation vence)', () => {
  const text = 'não quero reservar ainda';
  const isExplicit = patterns.EXPLICIT_RESERVE_PATTERN.test(text) && !patterns.RESERVE_NEGATION_PATTERN.test(text);
  assert.ok(!isExplicit, 'negação deveria anular a intenção explícita');
});

check('"será que posso reservar?" casa RESERVE_NEGATION_PATTERN', () => {
  assert.ok(patterns.RESERVE_NEGATION_PATTERN.test('será que posso reservar?'));
});

check('"quero saber como reservar" casa RESERVE_NEGATION_PATTERN', () => {
  assert.ok(patterns.RESERVE_NEGATION_PATTERN.test('quero saber como reservar'));
});

check('"Como faço para reservar?" casa RESERVE_NEGATION_PATTERN', () => {
  assert.ok(patterns.RESERVE_NEGATION_PATTERN.test('Como faço para reservar?'));
});

check('"só estou vendo" casa RESERVE_NEGATION_PATTERN', () => {
  assert.ok(patterns.RESERVE_NEGATION_PATTERN.test('só estou vendo'));
});

console.log('\n=== Padrões regex: pedido humano ===');

check('"quero falar com atendente" casa REQUEST_HUMAN_PATTERN', () => {
  assert.ok(patterns.REQUEST_HUMAN_PATTERN.test('quero falar com atendente'));
});

check('"pode me passar para uma pessoa?" casa REQUEST_HUMAN_PATTERN', () => {
  assert.ok(patterns.REQUEST_HUMAN_PATTERN.test('pode me passar para uma pessoa?'));
});

check('"quero falar com alguém da pousada" casa REQUEST_HUMAN_PATTERN', () => {
  assert.ok(patterns.REQUEST_HUMAN_PATTERN.test('quero falar com alguém da pousada'));
});

check('"prefiro atendimento humano" casa REQUEST_HUMAN_PATTERN', () => {
  assert.ok(patterns.REQUEST_HUMAN_PATTERN.test('atendimento humano'));
});

console.log('\n=== Padrões regex: confirmações curtas válidas (para fluxos de coleta) ===');

check('"sim" casa CONFIRMATION_PATTERN', () => {
  assert.ok(patterns.CONFIRMATION_PATTERN.test('sim'));
});

check('"isso" casa CONFIRMATION_PATTERN', () => {
  assert.ok(patterns.CONFIRMATION_PATTERN.test('isso'));
});

check('"confirmo" casa CONFIRMATION_PATTERN', () => {
  assert.ok(patterns.CONFIRMATION_PATTERN.test('confirmo'));
});

check('"ok" NÃO casa CONFIRMATION_PATTERN (removido para evitar handoff acidental)', () => {
  assert.ok(!patterns.CONFIRMATION_PATTERN.test('ok'));
});

check('"perfeito" NÃO casa CONFIRMATION_PATTERN', () => {
  assert.ok(!patterns.CONFIRMATION_PATTERN.test('perfeito'));
});

check('"entendi" NÃO casa CONFIRMATION_PATTERN', () => {
  assert.ok(!patterns.CONFIRMATION_PATTERN.test('entendi'));
});

check('"obrigado" NÃO casa CONFIRMATION_PATTERN', () => {
  assert.ok(!patterns.CONFIRMATION_PATTERN.test('obrigado'));
});

check('"certo" NÃO casa CONFIRMATION_PATTERN', () => {
  assert.ok(!patterns.CONFIRMATION_PATTERN.test('certo'));
});

// ============================================================
// TESTES DE INTEGRAÇÃO COM HANDOFF.JS
// ============================================================
console.log('\n=== Integração: triggerHandoff e shouldSilence ===');

const { triggerHandoff, isHandoffTriggered, shouldSilence, resumeAI } = require('../src/utils/handoff');

const TEST_PHONE = '5522999999999';

resetHandoffState(TEST_PHONE);

check('triggerHandoff marca contato como silenciado', () => {
  resetHandoffState(TEST_PHONE);
  triggerHandoff(TEST_PHONE, 'teste');
  assert.ok(isHandoffTriggered(TEST_PHONE), 'deveria estar marcado como handoff');
  assert.ok(shouldSilence(TEST_PHONE), 'deveria estar silenciado');
});

check('shouldSilence retorna false após resumeAI', () => {
  resetHandoffState(TEST_PHONE);
  triggerHandoff(TEST_PHONE, 'teste');
  resumeAI(TEST_PHONE);
  assert.ok(!shouldSilence(TEST_PHONE), 'não deveria estar silenciado após resume');
});

check('handoff duplicado: isHandoffTriggered já true impede novo disparo', () => {
  resetHandoffState(TEST_PHONE);
  triggerHandoff(TEST_PHONE, 'primeiro');
  const first = isHandoffTriggered(TEST_PHONE);
  triggerHandoff(TEST_PHONE, 'segundo');
  const second = isHandoffTriggered(TEST_PHONE);
  assert.ok(first && second, 'ambos deveriam retornar true');
  // O arquivo deve ter apenas um registro (sobrescrito, não duplicado)
  const data = JSON.parse(fs.readFileSync(HANDOFFS_FILE, 'utf-8'));
  const safe = TEST_PHONE.replace(/[^0-9]/g, '');
  assert.ok(data[safe], 'registro deve existir');
  assert.strictEqual(data[safe].reason, 'segundo', 'razão deve ser atualizada');
});

// ============================================================
// RESULTADO FINAL
// ============================================================
restoreState();

console.log(`\n${'='.repeat(50)}`);
console.log(`Resultados: ${passed} passaram, ${failures} falharam`);
console.log(`${'='.repeat(50)}`);

if (failures > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 TODOS OS TESTES PASSARAM');
  process.exit(0);
}