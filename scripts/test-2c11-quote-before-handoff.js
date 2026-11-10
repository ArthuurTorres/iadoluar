#!/usr/bin/env node
'use strict';

/**
 * Testes da Etapa 2C.11 — Orçamento antes da confirmação e do handoff
 *
 * Cenários:
 * G1 - Estado: quoteGenerated/quotePresented/handoffConfirmed existem e nascem falsos
 * G2 - persistResult('quote') grava a cotação e nasce NÃO apresentada
 * G3 - markQuotePresented só vale quando houve geração
 * G4 - isQuoteValidFor devolve null sem apresentação ou sem cotação
 * G5 - isQuoteValidFor invalida quando os dados da conversa mudam
 * G6 - Caso real: 05/12→10/12, 2 adultos, Conchas = R$ 1.499,50
 * G7 - Período fora da tabela não gera cotação falsa
 * G8 - Troca de suíte após cotação limpa lastQuote e derruba as flags
 */

const { getState, updateState, persistResult, markQuotePresented, isQuoteValidFor, markHandoffConfirmed, clearHistory } = require('../src/utils/context');
const { calculateQuote } = require('../src/utils/pricing');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`✅ ${testName}`);
    passed++;
  } else {
    console.log(`❌ ${testName}`);
    failed++;
  }
}

// --- G1: Campos novos existem e nascem falsos ---
{
  const phone = '5599TEST_G1';
  clearHistory(phone);
  updateState(phone, { adults: 2, children: 0 });
  const state = getState(phone);
  assert(
    'quoteGenerated' in state && 'quotePresented' in state && 'handoffConfirmed' in state,
    'G1 - Estado tem quoteGenerated, quotePresented e handoffConfirmed'
  );
  assert(
    state.quoteGenerated === false && state.quotePresented === false && state.handoffConfirmed === false,
    'G1 - Flags nascem falsas'
  );
  clearHistory(phone);
}

// --- G2: Cotação nasce gerada, mas NÃO apresentada ---
{
  const phone = '5599TEST_G2';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, children: 0, childrenAges: [], selectedRoom: 'Conchas' });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, childrenAges: [], room: 'Conchas' },
    { total: 1499.5, nights: 5 }
  );
  const state = getState(phone);
  assert(state.quoteGenerated === true, 'G2 - persistResult marca quoteGenerated');
  assert(state.quotePresented === false, 'G2 - Cotação gerada NÃO conta como apresentada');
  assert(state.lastQuote && state.lastQuote.result.total === 1499.5, 'G2 - lastQuote guarda o total');
  clearHistory(phone);
}

// --- G3: markQuotePresented exige cotação gerada ---
{
  const phone = '5599TEST_G3';
  clearHistory(phone);
  updateState(phone, { adults: 2 });
  markQuotePresented(phone);
  assert(getState(phone).quotePresented === false, 'G3 - Sem cotação gerada, não marca apresentada');

  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', selectedRoom: 'Conchas' });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, childrenAges: [], room: 'Conchas' },
    { total: 1499.5, nights: 5 }
  );
  markQuotePresented(phone);
  assert(getState(phone).quotePresented === true, 'G3 - Com cotação gerada, marca apresentada');
  clearHistory(phone);
}

// --- G4: isQuoteValidFor devolve null sem apresentação ---
{
  const phone = '5599TEST_G4';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, children: 0, childrenAges: [], selectedRoom: 'Conchas' });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, childrenAges: [], room: 'Conchas' },
    { total: 1499.5, nights: 5 }
  );
  assert(isQuoteValidFor(phone) === null, 'G4 - Gerada mas não apresentada → inválida para handoff');

  markQuotePresented(phone);
  assert(isQuoteValidFor(phone) !== null, 'G4 - Apresentada → válida para handoff');
  clearHistory(phone);
}

// --- G5: Dados diferentes do estado invalidam a cotação ---
{
  const phone = '5599TEST_G5';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, children: 0, childrenAges: [], selectedRoom: 'Conchas' });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, childrenAges: [], room: 'Conchas' },
    { total: 1499.5, nights: 5 }
  );
  markQuotePresented(phone);

  const wrongDates = isQuoteValidFor(phone, { checkIn: '2026-12-06' });
  assert(wrongDates === null, 'G5 - Data diferente da cotada invalida');

  const wrongRoom = isQuoteValidFor(phone, { selectedRoom: 'Peró' });
  assert(wrongRoom === null, 'G5 - Suíte diferente da cotada invalida');
  clearHistory(phone);
}

// --- G6: Caso real do atendimento (tabela de preços) ---
{
  const result = calculateQuote('2026-12-05', '2026-12-10', 2, [], { capacity: 2, pricePerNight: 299.9 });
  assert(result.ok === true, 'G6 - Cotação do caso real é calculada');
  assert(result.total === 1499.5, `G6 - 5 noites × R$ 299,90 = R$ 1.499,50 (obtido: ${result.total})`);
  assert(result.nights === 5, 'G6 - 5 noites entre 05/12 e 10/12');
}

// --- G7: Período fora da tabela não gera cotação falsa ---
{
  const result = calculateQuote('2028-06-01', '2028-06-05', 2, [], { capacity: 2 });
  assert(result.ok === false, 'G7 - Data fora da tabela retorna ok=false');
  assert(result.reason === 'outside_table', 'G7 - Motivo é outside_table');
}

// --- G8: Troca de suíte após cotação limpa lastQuote e derruba as flags ---
{
  const phone = '5599TEST_G8';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, children: 0, childrenAges: [], selectedRoom: 'Conchas' });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 2, childrenAges: [], room: 'Conchas' },
    { total: 1499.5, nights: 5 }
  );
  markQuotePresented(phone);
  markHandoffConfirmed(phone);
  assert(getState(phone).quotePresented === true, 'G8 - Antes da troca, cotação apresentada');

  updateState(phone, { selectedRoom: 'Peró' });
  const after = getState(phone);
  assert(after.lastQuote === null, 'G8 - Troca de suíte limpa lastQuote');
  assert(after.quotePresented === false, 'G8 - Troca de suíte derruba quotePresented');
  assert(after.handoffConfirmed === false, 'G8 - Troca de suíte derruba handoffConfirmed');
  clearHistory(phone);
}

// --- G10: Suíte recomendada automaticamente (cliente não escolheu) não invalida ---
// Regressione do atendimento real: o orçamento é gerado para a suíte recomendada
// e o estado não tem selectedRoom. Antes, o handoff era bloqueado para sempre.
{
  const phone = '5599TEST_G10';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 4, children: 0, childrenAges: [] });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 4, childrenAges: [], room: 'Peró' },
    { total: 2699.5, nights: 5 }
  );
  markQuotePresented(phone);
  assert(getState(phone).selectedRoom === null, 'G10 - Estado sem suíte escolhida');
  const valid = isQuoteValidFor(phone);
  assert(valid !== null, 'G10 - Orçamento da suíte recomendada vale para o handoff');
  assert(valid.params.room === 'Peró', 'G10 - Vale pela suíte que foi cotada');
  clearHistory(phone);
}

// --- G11: Suíte escolhida diferente da cotada continua invalidando ---
{
  const phone = '5599TEST_G11';
  clearHistory(phone);
  updateState(phone, { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 4, children: 0, childrenAges: [] });
  persistResult(
    phone,
    'quote',
    { checkIn: '2026-12-05', checkOut: '2026-12-10', adults: 4, childrenAges: [], room: 'Peró' },
    { total: 2699.5, nights: 5 }
  );
  markQuotePresented(phone);
  assert(isQuoteValidFor(phone, { selectedRoom: 'Conchas' }) === null, 'G11 - Suíte escolhida diferente da cotada invalida');
  clearHistory(phone);
}

console.log(`\n=== Resultado Etapa 2C.11 ===`);
console.log(`✅ ${passed} passaram | ❌ ${failed} falharam | Total: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);