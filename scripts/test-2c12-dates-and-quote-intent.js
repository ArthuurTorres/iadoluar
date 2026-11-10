#!/usr/bin/env node
'use strict';

/**
 * Testes da Etapa 2C.12 — Persistência de datas validadas e intenção de orçamento
 *
 * Cenários:
 * D1 - Formato "entrada 05 de janeiro saída 10 de janeiro"
 * D2 - Formato "dia 05/01 ao dia 10/01" (e variantes com "dia")
 * D3 - Formatos antigos continuam funcionando (regressão de C3)
 * D4 - Texto sem datas continua devolvendo null
 * Q1 - Intenções de orçamento que falhavam: "e o valor?", "quanto vou pagar?", "qual o total"
 * Q2 - Formatos antigos de intenção continuam casando
 * Q3 - Perguntas comuns NÃO são confundidas com intenção de orçamento
 * R1 - Datas validadas são persistidas no estado (C1)
 * R2 - selectedRoom gravado como nome é resolvido para objeto do catálogo (C2)
 */

const fs = require('fs');
const path = require('path');

const ORCH_PATH = path.join(__dirname, '..', 'src', 'orchestrator.js');
const src = fs.readFileSync(ORCH_PATH, 'utf8');

// Extrai as funções puras do orquestrador sem carregar o módulo inteiro
// (evita dependência de LLM_API_KEY, banco e rede).
function sliceBetween(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) throw new Error(`Trecho não encontrado: ${startMarker}`);
  return src.slice(start, end);
}

const monthMapSrc = sliceBetween('const MONTH_MAP', 'async function callLLM');
const datesSrc = sliceBetween('function extractDates', 'function buildRangeFromDaysAndMonth');
const buildSrc = sliceBetween('function buildRangeFromDaysAndMonth', 'function validateDates');
const quoteIntentSrc = sliceBetween('const QUOTE_INTENT_PATTERN', '// Cliente aceita qualquer suíte');
const roomCatalogSrc = sliceBetween('const ROOM_CATALOG', 'function recommendRooms');
const roomHelpersSrc = sliceBetween('/** Suíte citada pelo cliente', '/** Última contagem de adultos');

const loadPure = () => new Function(
  `${monthMapSrc}\n${datesSrc}\n${buildSrc}\n${quoteIntentSrc}\n${roomCatalogSrc}\n${roomHelpersSrc}\n` +
  'return { extractDates, detectQuoteRequest: (t) => QUOTE_INTENT_PATTERN.test(t), selectedRoomFromText, roomByName };'
)();

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

let pure;
try {
  pure = loadPure();
} catch (err) {
  console.log(`❌ Não foi possível extrair as funções do orquestrador: ${err.message}`);
  process.exit(1);
}

const { extractDates, detectQuoteRequest, selectedRoomFromText, roomByName } = pure;

// --- D1: rótulos "entrada"/"saída" com mês por extenso ---
{
  const r = extractDates('entrada 05 de janeiro saída 10 de janeiro');
  assert(r && /-01-05$/.test(r.checkIn) && /-01-10$/.test(r.checkOut),
    `D1 "entrada 05 de janeiro saída 10 de janeiro" -> ${JSON.stringify(r)}`);

  const r2 = extractDates('entrada 05/01 e saída 10/01');
  assert(r2 && /-01-05$/.test(r2.checkIn) && /-01-10$/.test(r2.checkOut),
    `D1 "entrada 05/01 e saída 10/01" -> ${JSON.stringify(r2)}`);

  const r3 = extractDates('check-in 05/01 check-out 10/01');
  assert(r3 && /-01-05$/.test(r3.checkIn) && /-01-10$/.test(r3.checkOut),
    `D1 "check-in 05/01 check-out 10/01" -> ${JSON.stringify(r3)}`);
}

// --- D2: "dia DD/MM ao dia DD/MM" ---
{
  const r = extractDates('dia 05/01 ao dia 10/01');
  assert(r && /-01-05$/.test(r.checkIn) && /-01-10$/.test(r.checkOut),
    `D2 "dia 05/01 ao dia 10/01" -> ${JSON.stringify(r)}`);

  const r2 = extractDates('dia 05/12 a dia 10/12');
  assert(r2 && /-12-05$/.test(r2.checkIn) && /-12-10$/.test(r2.checkOut),
    `D2 "dia 05/12 a dia 10/12" -> ${JSON.stringify(r2)}`);
}

// --- D3: formatos antigos preservados (C3 não pode quebrar o que já funcionava) ---
{
  const casos = [
    ['de 5 a 10 de janeiro', /-01-05$/, /-01-10$/],
    ['05/01 a 10/01', /-01-05$/, /-01-10$/],
    ['de 05/12 a 10/12', /-12-05$/, /-12-10$/],
    ['quero 20 de dezembro ate 27 de dezembro', /-12-20$/, /-12-27$/],
    ['dia 30 ate dia 4 de dezembro para janeiro', /-12-30$/, /-01-04$/],
  ];
  let todosOk = true;
  for (const [texto, inRe, outRe] of casos) {
    const r = extractDates(texto);
    if (!r || !inRe.test(r.checkIn) || !outRe.test(r.checkOut)) {
      todosOk = false;
      console.log(`   ↳ quebrou: "${texto}" -> ${JSON.stringify(r)}`);
    }
  }
  assert(todosOk, 'D3 formatos antigos de data continuam funcionando');
}

// --- D4: sem datas, continua null ---
{
  assert(extractDates('oi, tudo bem?') === null, 'D4 texto sem datas devolve null');
  assert(extractDates('vou dia 20 de janeiro') === null, 'D4 data única sem intervalo devolve null');
}

// --- Q1: intenções que falhavam ---
{
  const casos = ['e o valor?', 'quanto vou pagar?', 'vou pagar quanto?', 'qual o total', 'e sobre o valor'];
  let todosOk = true;
  for (const texto of casos) {
    if (!detectQuoteRequest(texto)) {
      todosOk = false;
      console.log(`   ↳ não reconheceu: "${texto}"`);
    }
  }
  assert(todosOk, 'Q1 intenções de orçamento antes não reconhecidas agora casam');
}

// --- Q2: formatos antigos preservados ---
{
  const casos = [
    'quanto custa?', 'quanto fica 5 noites?', 'qual o valor da suite?',
    'me passa o orçamento', 'qual a diária?', 'quanto por noite?', 'e o preço?', 'quanto sai tudo?',
  ];
  let todosOk = true;
  for (const texto of casos) {
    if (!detectQuoteRequest(texto)) {
      todosOk = false;
      console.log(`   ↳ quebrou: "${texto}"`);
    }
  }
  assert(todosOk, 'Q2 formatos antigos de intenção continuam funcionando');
}

// --- Q3: sem falso positivo ---
{
  const casos = ['oi', 'bom dia', 'qual a localização?', 'tem wifi?', 'quero reservar', 'como chego', 'obrigado', 'tudo bem'];
  let todosOk = true;
  for (const texto of casos) {
    if (detectQuoteRequest(texto)) {
      todosOk = false;
      console.log(`   ↳ falso positivo: "${texto}"`);
    }
  }
  assert(todosOk, 'Q3 perguntas comuns não são confundidas com intenção de orçamento');
}

// --- R1: datas validadas são persistidas no estado (C1) ---
{
  const { getState, updateState, clearHistory } = require('../src/utils/context');
  const phone = '5599TEST_2C12_R1';
  clearHistory(phone);

  // A FASE 0 grava a data crua; o bloco de disponibilidade precisa gravar a validada.
  updateState(phone, { checkIn: '2026-01-05', checkOut: '2026-01-10', adults: 2, children: 0 });
  const cru = getState(phone);
  assert(cru.checkIn === '2026-01-05', `R1a estado aceita a data crua gravada pela FASE 0 (${cru.checkIn})`);

  updateState(phone, { checkIn: '2027-01-05', checkOut: '2027-01-10' });
  const corrigido = getState(phone);
  assert(corrigido.checkIn === '2027-01-05' && corrigido.checkOut === '2027-01-10',
    `R1b estado recebe a data CORRIGIDA por validateDates (${corrigido.checkIn} → ${corrigido.checkOut})`);

  const fonte = fs.readFileSync(ORCH_PATH, 'utf8');
  const bloco = fonte.slice(
    fonte.indexOf('// C1:'),
    fonte.indexOf('persistResult(phoneNumber', fonte.indexOf('// C1:'))
  );
  assert(bloco.includes('finalCheckIn') && bloco.includes('updateState'),
    'R1c o bloco de disponibilidade persiste finalCheckIn (data validada) no estado');

  clearHistory(phone);
}

// --- R2: nome persistido é resolvido para objeto do catálogo (C2) ---
{
  const porTexto = selectedRoomFromText('Gostei das conchas');
  assert(porTexto && porTexto.name === 'Conchas' && typeof porTexto.capacity === 'number',
    `R2a "Gostei das conchas" resolve objeto do catálogo (${porTexto && porTexto.name})`);

  const porNome = roomByName('Foguete');
  assert(porNome && porNome.name === 'Foguete', `R2b roomByName("Foguete") resolve o objeto (${porNome && porNome.name})`);

  assert(roomByName('Suíte Inexistente') === null, 'R2c roomByName de nome desconhecido devolve null');

  const fonte = fs.readFileSync(ORCH_PATH, 'utf8');
  // state.selectedRoom é STRING (nome): precisa passar por roomByName antes de virar objeto.
  const linha = fonte.split('\n').find(l => l.includes('roomByName(state.selectedRoom)'));
  const cru = fonte.split('\n').find(l => /selectedRoomFromText\(cleanText\)\s*\|\|\s*state\.selectedRoom/.test(l));
  assert(!!linha && !cru,
    'R2d state.selectedRoom (string) passa por roomByName antes de virar objeto');
}

console.log(`\n${failed === 0 ? '✅ TUDO OK' : '❌ HOUVE FALHAS'} — ${passed} passaram, ${failed} falharam`);
process.exit(failed === 0 ? 0 : 1);
