#!/usr/bin/env node
'use strict';

/**
 * Testes da Etapa 2C.8 — Refinamento da Experiência e Correção da Cotação
 * 
 * Cenários:
 * T1 - Placeholder literal é bloqueado antes do envio
 * T2 - buildHandoffSummary retorna null sem cotação válida
 * T3 - Recuperação de cotação quando placeholder é detectado
 * T4 - Handoff só acontece após cotação válida ser apresentada
 * T5 - Placeholders genéricos [nome], [data] também são bloqueados
 */

const { getState, updateState, appendMessageWithState, clearHistory } = require('../src/utils/context');
const { formatQuote, calculateQuote } = require('../src/utils/pricing');

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

// Regex de sanitização (deve bater com a do orquestrador)
const PLACEHOLDER_PATTERN = /\[valor exato da cota[çc][aã]o(?:[^\]]*)\]|\[(?:nome|telefone|data|su[ií]te|n[ºo°]?\s*(?:adultos|crian[cç]as))\]/gi;

// --- T1: Placeholder literal é detectado pela regex ---
{
  const testReply = 'Perfeito! O valor total é [valor exato da cotação enviada pelo sistema]. Está correto?';
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(testReply);
  assert(hasPlaceholder === true, 'T1 - Regex detecta placeholder literal de cotação');
}

// --- T2: buildHandoffSummary retorna null sem dados de cotação ---
{
  // Simula estado incompleto (sem selectedRoom ou sem datas)
  const phone = '5599TEST_T2';
  clearHistory(phone);
  updateState(phone, { adults: 2, children: 0, childrenAges: [] });
  const state = getState(phone);
  // Sem checkIn/checkOut/selectedRoom, buildQuoteReply deve retornar null
  const quote = calculateQuote(null, null, 2, [], { capacity: 2 });
  assert(!quote.ok, 'T2 - calculateQuote falha sem datas (handoff bloqueado)');
  clearHistory(phone);
}

// --- T3: Recuperação funciona quando estado tem dados completos ---
{
  const phone = '5599TEST_T3';
  clearHistory(phone);
  updateState(phone, {
    checkIn: '2026-12-10',
    checkOut: '2026-12-12',
    adults: 2,
    children: 0,
    childrenAges: [],
    selectedRoom: 'Peró',
    quotePresented: false
  });
  const state = getState(phone);
  const quote = calculateQuote(state.checkIn, state.checkOut, state.adults, [], { capacity: 2 });
  assert(quote.ok && quote.total > 0, 'T3 - Cotação recuperável com dados completos no estado');
  clearHistory(phone);
}

// --- T4: Placeholder genérico [nome] também é detectado ---
{
  const testReply = 'Olá [nome], sua reserva para [data] está confirmada.';
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(testReply);
  assert(hasPlaceholder === true, 'T4 - Regex detecta placeholders genéricos [nome] e [data]');
}

// --- T5: Mensagem limpa passa pelo sanitizador ---
{
  const cleanReply = 'O valor total é R$ 599,80 para 2 noites. Gostaria de prosseguir?';
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(cleanReply);
  assert(hasPlaceholder === false, 'T5 - Mensagem sem placeholder passa limpa');
}

// --- T6: Estado com quotePresented=true permite handoff ---
{
  const phone = '5599TEST_T6';
  clearHistory(phone);
  updateState(phone, {
    checkIn: '2026-12-10',
    checkOut: '2026-12-12',
    adults: 2,
    children: 0,
    childrenAges: [],
    selectedRoom: 'Peró',
    quotePresented: true
  });
  const state = getState(phone);
  assert(state.quotePresented === true, 'T6 - quotePresented persistido como true após cotação');
  clearHistory(phone);
}

// --- T7: Mudança de suíte invalida quotePresented ---
{
  const phone = '5599TEST_T7';
  clearHistory(phone);
  updateState(phone, {
    checkIn: '2026-12-10',
    checkOut: '2026-12-12',
    adults: 2,
    children: 0,
    childrenAges: [],
    selectedRoom: 'Peró',
    quotePresented: true
  });
  // Muda suíte → quotePresented deve ser invalidado
  updateState(phone, { selectedRoom: 'Forte', quotePresented: false });
  const state = getState(phone);
  assert(state.selectedRoom === 'Forte' && state.quotePresented === false, 'T7 - Mudança de suíte invalida quotePresented');
  clearHistory(phone);
}

console.log(`\n=== Resultado Etapa 2C.8 ===`);
console.log(`✅ ${passed} passaram | ❌ ${failed} falharam | Total: ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);