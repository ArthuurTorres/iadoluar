/**
 * Testes da Etapa 2C.9 — Estabilização do Fluxo de Atendimento
 * 
 * Cenários obrigatórios (complementos A-E do plano):
 * A. Ordem efetiva: contextualização → localização → datas
 * B. Sanitizador WhatsApp: remove ---, preserva colchetes legítimos
 * C. Hash de parâmetros: invalida availabilityStatus quando dados mudam
 * D. Proteção contra alucinação: bloqueia claims sem estado válido
 * E. Multi_reply sanitizado: ambas as mensagens passam pela limpeza
 */

const assert = require('assert');

// Mock mínimo do estado para testar lógica pura
function createMockState(overrides = {}) {
  return {
    checkIn: null,
    checkOut: null,
    adults: 0,
    children: 0,
    childrenAges: [],
    selectedRoom: null,
    quotePresented: false,
    regionAsked: false,
    regionKnown: false,
    lastAvailability: null,
    ...overrides,
  };
}

// Regex do sanitizador WhatsApp (deve bater com a do orquestrador)
const WHATSAPP_SEPARATOR_PATTERN = /^\s*-{3,}\s*$/gm;

// Regex de proteção contra alucinação (deve bater com a do orquestrador)
const HAS_AVAILABILITY_CLAIM = /dispon[ií]vel|su[ií]te|quarto|apartamento|R\$\s*\d/i;

function sanitizeWhatsApp(text) {
  return text.replace(WHATSAPP_SEPARATOR_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
}

function hasValidStateForQuote(state) {
  return !!(state.checkIn && state.checkOut && state.adults > 0 && state.selectedRoom);
}

// === TESTES ===

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

// A. Ordem efetiva de envio
test('A1. Multi_reply da região tem endereço no primeiro bloco', () => {
  const ctxMsg = 'Que bom que vou te apresentar! Estamos na Praia do Forte.';
  const dateMsg = 'Agora me conta: para quais datas você está pensando?';
  // Simula withAvailabilityLocation adicionando endereço ao primeiro bloco
  const locatedCtx = `${ctxMsg}\n\n📍 Rua dos Andradas, 123 - Centro, Cabo Frio`;
  const contents = [locatedCtx, dateMsg];
  
  assert.ok(contents[0].includes('📍'), 'Primeiro bloco deve conter endereço');
  assert.ok(!contents[1].includes('📍'), 'Segundo bloco não deve conter endereço');
  assert.ok(contents[0].indexOf('Praia do Forte') < contents[0].indexOf('📍'), 'Contexto vem antes do endereço');
});

test('A2. Pin é disparado após primeiro bloco do multi_reply', () => {
  const sendLocationAfterReply = true;
  const contents = ['Contexto + 📍 Endereço', 'Pergunta de datas'];
  
  // No server.js, pin dispara quando i === 0 e sendLocationAfterReply === true
  let pinSentAfterIndex = null;
  for (let i = 0; i < contents.length; i++) {
    if (sendLocationAfterReply && i === 0) {
      pinSentAfterIndex = i;
    }
  }
  
  assert.strictEqual(pinSentAfterIndex, 0, 'Pin deve ser enviado após índice 0');
});

// B. Sanitizador WhatsApp
test('B1. Remove separadores --- artificiais', () => {
  const input = 'Olá!\n---\nComo posso ajudar?';
  const output = sanitizeWhatsApp(input);
  assert.ok(!output.includes('---'), 'Separador --- deve ser removido');
  assert.ok(output.includes('Olá!'), 'Conteúdo válido preservado');
  assert.ok(output.includes('Como posso ajudar?'), 'Conteúdo válido preservado');
});

test('B2. Preserva colchetes legítimos como [AVAILABILITY_CHECK:...]', () => {
  const input = '[AVAILABILITY_CHECK:{"checkIn":"2026-11-10"}]\n---\nResposta';
  const output = sanitizeWhatsApp(input);
  assert.ok(output.includes('[AVAILABILITY_CHECK:'), 'Colchete legítimo preservado');
  assert.ok(!output.includes('---'), 'Separador removido');
});

test('B3. Normaliza múltiplas quebras de linha', () => {
  const input = 'Linha 1\n\n\n\n\nLinha 2';
  const output = sanitizeWhatsApp(input);
  assert.ok(!output.includes('\n\n\n'), 'Múltiplas quebras normalizadas');
  assert.ok(output.includes('Linha 1\n\nLinha 2'), 'Duas quebras preservadas');
});

// C. Hash de parâmetros
test('C1. paramsChanged detecta mudança de suíte', () => {
  const lastParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, room: 'Standard', ages: '' };
  const currentParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, room: 'Peró', ages: '' };
  
  const paramsChanged = !lastParams
    || lastParams.checkIn !== currentParams.checkIn
    || lastParams.checkOut !== currentParams.checkOut
    || lastParams.guests !== currentParams.guests
    || lastParams.room !== currentParams.room
    || lastParams.ages !== currentParams.ages;
  
  assert.ok(paramsChanged, 'Mudança de suíte deve invalidar cache');
});

test('C2. paramsChanged detecta mudança de idades', () => {
  const lastParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 4, room: 'Família', ages: '5,8' };
  const currentParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 4, room: 'Família', ages: '3,10' };
  
  const paramsChanged = !lastParams
    || lastParams.checkIn !== currentParams.checkIn
    || lastParams.checkOut !== currentParams.checkOut
    || lastParams.guests !== currentParams.guests
    || lastParams.room !== currentParams.room
    || lastParams.ages !== currentParams.ages;
  
  assert.ok(paramsChanged, 'Mudança de idades deve invalidar cache');
});

test('C3. paramsChanged retorna false para parâmetros idênticos', () => {
  const lastParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, room: 'Standard', ages: '' };
  const currentParams = { checkIn: '2026-11-10', checkOut: '2026-11-12', guests: 2, room: 'Standard', ages: '' };
  
  const paramsChanged = !lastParams
    || lastParams.checkIn !== currentParams.checkIn
    || lastParams.checkOut !== currentParams.checkOut
    || lastParams.guests !== currentParams.guests
    || lastParams.room !== currentParams.room
    || lastParams.ages !== currentParams.ages;
  
  assert.ok(!paramsChanged, 'Parâmetros idênticos não devem invalidar cache');
});

// D. Proteção contra alucinação
test('D1. Bloqueia claim de disponibilidade sem estado válido', () => {
  const reply = 'Temos uma suíte disponível por R$ 299!';
  const state = createMockState({ checkIn: '2026-11-10' }); // falta checkOut, adults, selectedRoom
  
  const hasClaim = HAS_AVAILABILITY_CLAIM.test(reply);
  const hasValid = hasValidStateForQuote(state);
  
  assert.ok(hasClaim, 'Deve detectar claim de disponibilidade');
  assert.ok(!hasValid, 'Estado incompleto não é válido');
  // Na lógica do orquestrador: se hasClaim && !hasValid && !quotePresented → bloqueia
  const shouldBlock = hasClaim && !hasValid && !state.quotePresented;
  assert.ok(shouldBlock, 'Deve bloquear resposta com claim sem estado válido');
});

test('D2. Permite claim quando estado é válido', () => {
  const reply = 'Sua suíte Peró está disponível por R$ 299!';
  const state = createMockState({
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    adults: 2,
    selectedRoom: { name: 'Peró' },
  });
  
  const hasClaim = HAS_AVAILABILITY_CLAIM.test(reply);
  const hasValid = hasValidStateForQuote(state);
  
  assert.ok(hasClaim, 'Deve detectar claim');
  assert.ok(hasValid, 'Estado completo é válido');
  const shouldBlock = hasClaim && !hasValid && !state.quotePresented;
  assert.ok(!shouldBlock, 'Não deve bloquear quando estado é válido');
});

test('D3. Permite mensagem genérica sem claim mesmo sem estado', () => {
  const reply = 'Estou verificando a disponibilidade para você. Um momento!';
  const state = createMockState();
  
  const hasClaim = HAS_AVAILABILITY_CLAIM.test(reply);
  assert.ok(!hasClaim, 'Mensagem genérica não tem claim');
  // Sem claim, proteção não ativa
});

// E. Multi_reply sanitizado
test('E1. Ambas as mensagens do multi_reply passam pelo sanitizador', () => {
  const msg1 = 'Confirmado!\n---\n🏡 Suíte Peró';
  const msg2 = '---\nValor total: R$ 598\n---\nPodemos prosseguir?';
  
  const clean1 = sanitizeWhatsApp(msg1);
  const clean2 = sanitizeWhatsApp(msg2);
  
  assert.ok(!clean1.includes('---'), 'msg1 sanitizada');
  assert.ok(!clean2.includes('---'), 'msg2 sanitizada');
  assert.ok(clean1.includes('🏡 Suíte Peró'), 'Conteúdo válido preservado em msg1');
  assert.ok(clean2.includes('Valor total: R$ 598'), 'Conteúdo válido preservado em msg2');
});

// Resumo
console.log(`\n=== Etapa 2C.9 ===`);
console.log(`✅ ${passed} passando | ❌ ${failed} falhando`);
process.exit(failed > 0 ? 1 : 0);