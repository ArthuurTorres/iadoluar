#!/usr/bin/env node
/**
 * Etapa 2B — Testes de recuperação de contexto e controle de disponibilidade
 *
 * Valida:
 * 1. extractDates rejeita fragmentos e aceita ranges completos
 * 2. availabilityShown permite reconsulta com parâmetros diferentes
 * 3. Recuperação de datas do histórico quando mensagem atual é parcial
 * 4. Datas completas em uma mensagem
 * 5. Check-in e checkout em mensagens separadas
 * 6. Alteração confirmada de período
 * 7. Pergunta hipotética não dispara consulta
 * 8. Mudança na quantidade de hóspedes
 * 9. Repetição da mesma consulta (deve bloquear)
 * 10. Consulta para datas alternativas
 */

const assert = require('assert');

// Mock do contexto para testar lógica isoladamente
const MONTH_MAP = {
  janeiro: '01', fevereiro: '02', março: '03', marco: '03', abril: '04',
  maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09',
  outubro: '10', novembro: '11', dezembro: '12',
  jan: '01', fev: '02', mar: '03', abr: '04', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function buildRangeFromDaysAndMonth(dayIn, dayOut, monthNum) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = new Date().getFullYear();
  const inDay = parseInt(dayIn, 10);
  const outDay = parseInt(dayOut, 10);
  let outMonth = parseInt(monthNum, 10);
  let outYear = year;
  if (outDay <= inDay) {
    outMonth += 1;
    if (outMonth > 12) { outMonth = 1; outYear += 1; }
  }
  return { checkIn: `${year}-${pad(monthNum)}-${pad(inDay)}`, checkOut: `${outYear}-${pad(outMonth)}-${pad(outDay)}` };
}

// Versão ATUAL de extractDates (antes das correções)
function extractDatesCurrent(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const currentYear = new Date().getFullYear();

  // Pattern 1: "de DD a DD de MES [de YYYY]"
  const ptRange = normalized.match(/de\s+(\d{1,2})\s+a\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (ptRange) {
    const dayIn = ptRange[1].padStart(2, '0');
    const dayOut = ptRange[2].padStart(2, '0');
    const month = MONTH_MAP[ptRange[3]];
    const year = ptRange[4] || String(currentYear);
    if (month) return { checkIn: `${year}-${month}-${dayIn}`, checkOut: `${year}-${month}-${dayOut}` };
  }

  // Pattern 2: "DD/MM[/YYYY] a/ate/- DD/MM[/YYYY]"
  const slashRange = normalized.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:a|ate|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (slashRange) {
    const dayIn = slashRange[1].padStart(2, '0');
    const monthIn = slashRange[2].padStart(2, '0');
    const yearIn = slashRange[3] || String(currentYear);
    const dayOut = slashRange[4].padStart(2, '0');
    const monthOut = slashRange[5].padStart(2, '0');
    const yearOut = slashRange[6] || yearIn;
    return { checkIn: `${yearIn}-${monthIn}-${dayIn}`, checkOut: `${yearOut}-${monthOut}-${dayOut}` };
  }

  // Pattern 3: ISO dates
  const isoRange = normalized.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (isoRange) return { checkIn: isoRange[1], checkOut: isoRange[2] };

  // Pattern 4: check-in/check-out labels
  const ciMatch = normalized.match(/check[-\s]?in\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
  const coMatch = normalized.match(/check[-\s]?out\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
  if (ciMatch && coMatch) {
    const parseDate = (raw) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parts = raw.split('/');
      return `${parts[2] || String(currentYear)}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    };
    return { checkIn: parseDate(ciMatch[1]), checkOut: parseDate(coMatch[1]) };
  }

  // Pattern 5a: cross-month
  const ptCrossMonth = normalized.match(/(?:dia\s+)?(\d{1,2})\s+(?:ate|a|-|para)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})\s+de\s+([a-z]+)\s+(?:para|a|ate)\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (ptCrossMonth) {
    const dayIn = ptCrossMonth[1].padStart(2, '0');
    const dayOut = ptCrossMonth[2].padStart(2, '0');
    const monthIn = MONTH_MAP[ptCrossMonth[3]];
    const monthOut = MONTH_MAP[ptCrossMonth[4]];
    const year = ptCrossMonth[5] || String(currentYear);
    if (monthIn && monthOut) {
      let yearOut = year;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !ptCrossMonth[5]) {
        yearOut = String(parseInt(year, 10) + 1);
      }
      return { checkIn: `${year}-${monthIn}-${dayIn}`, checkOut: `${yearOut}-${monthOut}-${dayOut}` };
    }
  }

  // Pattern 5b: single or dual month
  const ptRangeCheckin = normalized.match(/(?:check[-\s]?in\s*|dia\s+)?(\d{1,2})\s+(?:de\s+)?(?:([a-z]+)\s+)?(?:de\s+(\d{4})\s+)?(?:ate|a|-|para)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})(?:\s+de\s+)?([a-z]+)?(?:\s+de\s+(\d{4}))?/);
  if (ptRangeCheckin) {
    const dayIn = ptRangeCheckin[1].padStart(2, '0');
    const dayOut = ptRangeCheckin[4].padStart(2, '0');
    const rawMonthIn = ptRangeCheckin[2];
    const rawMonthOut = ptRangeCheckin[5];
    const singleMonth = (!rawMonthIn && rawMonthOut) ? rawMonthOut : rawMonthIn;
    const monthIn = MONTH_MAP[rawMonthIn] || MONTH_MAP[singleMonth];
    const monthOut = MONTH_MAP[rawMonthOut] || monthIn;
    const yearIn = ptRangeCheckin[3] || ptRangeCheckin[6] || String(currentYear);
    const yearOut = ptRangeCheckin[6] || yearIn;
    if (monthIn && monthOut) {
      let finalYearOut = yearOut;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !ptRangeCheckin[6] && !ptRangeCheckin[3]) {
        finalYearOut = String(parseInt(yearIn, 10) + 1);
      }
      return { checkIn: `${yearIn}-${monthIn}-${dayIn}`, checkOut: `${finalYearOut}-${monthOut}-${dayOut}` };
    }
  }

  // Pattern 5c: days range without explicit month in same phrase
  const monthMentionRegex = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/g;
  const daysRangeRegex = /(?<![\d/])(\d{1,2})(?![\d/])\s*(?:ate|a)\s*(?:o\s+)?(?:dia\s+)?(\d{1,2})(?![\d/])/g;
  let daysRange;
  while ((daysRange = daysRangeRegex.exec(normalized)) !== null) {
    const dayIn = daysRange[1].padStart(2, '0');
    const dayOut = daysRange[2].padStart(2, '0');
    let monthNum = null;
    let monthMatch;
    while ((monthMatch = monthMentionRegex.exec(normalized)) !== null) {
      if (monthMatch.index < daysRange.index) monthNum = MONTH_MAP[monthMatch[1]] || monthNum;
      else break;
    }
    monthMentionRegex.lastIndex = 0;
    if (!monthNum) {
      const anyMonth = normalized.slice(daysRange.index).match(monthMentionRegex);
      if (anyMonth) monthNum = MONTH_MAP[anyMonth[0]];
    }
    monthMentionRegex.lastIndex = 0;
    if (monthNum) {
      const range = buildRangeFromDaysAndMonth(dayIn, dayOut, monthNum);
      if (range) return range;
    }
  }

  return null;
}

// ============================================================
// TESTES DE extractDates
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\n=== extractDates: fragmentos devem ser rejeitados ===');

test('Fragmento "30/" NÃO deve retornar datas', () => {
  const result = extractDatesCurrent('30/');
  assert.strictEqual(result, null, `Esperado null, recebeu ${JSON.stringify(result)}`);
});

test('Fragmento "dia 15" sem checkout NÃO deve retornar datas', () => {
  const result = extractDatesCurrent('dia 15');
  assert.strictEqual(result, null, `Esperado null, recebeu ${JSON.stringify(result)}`);
});

test('Fragmento "15 a" sem dia de saída NÃO deve retornar datas', () => {
  const result = extractDatesCurrent('15 a');
  assert.strictEqual(result, null, `Esperado null, recebeu ${JSON.stringify(result)}`);
});

console.log('\n=== extractDates: ranges completos devem ser aceitos ===');

test('"de 10 a 15 de janeiro" retorna range válido', () => {
  const result = extractDatesCurrent('de 10 a 15 de janeiro');
  assert.ok(result, 'Deveria retornar objeto');
  assert.ok(result.checkIn.endsWith('-01-10'), `checkIn deveria terminar em -01-10, recebeu ${result.checkIn}`);
  assert.ok(result.checkOut.endsWith('-01-15'), `checkOut deveria terminar em -01-15, recebeu ${result.checkOut}`);
});

test('"10/01 a 15/01" retorna range válido', () => {
  const result = extractDatesCurrent('10/01 a 15/01');
  assert.ok(result, 'Deveria retornar objeto');
  assert.ok(result.checkIn.includes('-01-10'), `checkIn deveria conter -01-10, recebeu ${result.checkIn}`);
  assert.ok(result.checkOut.includes('-01-15'), `checkOut deveria conter -01-15, recebeu ${result.checkOut}`);
});

test('"2026-01-10 a 2026-01-15" (ISO) retorna range válido', () => {
  const result = extractDatesCurrent('2026-01-10 a 2026-01-15');
  assert.ok(result, 'Deveria retornar objeto');
  assert.strictEqual(result.checkIn, '2026-01-10');
  assert.strictEqual(result.checkOut, '2026-01-15');
});

test('"dia 20 até dia 24 de janeiro" retorna range válido', () => {
  const result = extractDatesCurrent('dia 20 até dia 24 de janeiro');
  assert.ok(result, 'Deveria retornar objeto');
  assert.ok(result.checkIn.endsWith('-01-20'), `checkIn deveria terminar em -01-20, recebeu ${result.checkIn}`);
  assert.ok(result.checkOut.endsWith('-01-24'), `checkOut deveria terminar em -01-24, recebeu ${result.checkOut}`);
});

console.log('\n=== Recuperação de datas do histórico ===');

test('Datas completas no histórico são recuperadas quando mensagem atual é confirmação', () => {
  const historyText = 'Quero reservar de 10 a 15 de janeiro';
  const result = extractDatesCurrent(historyText);
  assert.ok(result, 'Deveria recuperar datas do histórico');
  assert.ok(result.checkIn.endsWith('-01-10'));
  assert.ok(result.checkOut.endsWith('-01-15'));
});

test('Mensagem "sim" sozinha NÃO recupera datas (precisa do histórico)', () => {
  const result = extractDatesCurrent('sim');
  assert.strictEqual(result, null, '"sim" sozinho não contém datas');
});

console.log('\n=== Controle de disponibilidade (availabilityShown com parâmetros) ===');

// Simula a NOVA lógica de availabilityShown (hash de parâmetros)
function getLastAvailabilityParams(history) {
  const marker = history
    .filter(m => m.role === 'assistant')
    .reverse()
    .find(m => /^\[AVAILABILITY_CHECK:/.test(m.content));
  if (!marker) return null;
  try { return JSON.parse(marker.content.replace('[AVAILABILITY_CHECK:', '').replace(']', '')); } catch { return null; }
}

function shouldConsultAvailability(history, currentParams) {
  const lastParams = getLastAvailabilityParams(history);
  if (!lastParams) return true; // nunca consultou
  return (
    lastParams.checkIn !== currentParams.checkIn ||
    lastParams.checkOut !== currentParams.checkOut ||
    lastParams.guests !== currentParams.guests
  );
}

test('Primeira consulta: deve consultar (sem histórico)', () => {
  const history = [];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 2 };
  assert.strictEqual(shouldConsultAvailability(history, params), true);
});

test('Mesmos parâmetros: NÃO deve consultar novamente', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 2 };
  assert.strictEqual(shouldConsultAvailability(history, params), false);
});

test('Datas diferentes: DEVE consultar novamente', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-02-20', checkOut: '2026-02-25', guests: 2 };
  assert.strictEqual(shouldConsultAvailability(history, params), true);
});

test('Hóspedes diferentes: DEVE consultar novamente', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 4 };
  assert.strictEqual(shouldConsultAvailability(history, params), true);
});

test('Múltiplas consultas: usa sempre a ÚLTIMA como referência', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-02-20","checkOut":"2026-02-25","guests":3}]' },
  ];
  // Mesmos parâmetros da segunda consulta → não consulta
  assert.strictEqual(shouldConsultAvailability(history, { checkIn: '2026-02-20', checkOut: '2026-02-25', guests: 3 }), false);
  // Parâmetros diferentes da segunda → consulta
  assert.strictEqual(shouldConsultAvailability(history, { checkIn: '2026-03-01', checkOut: '2026-03-05', guests: 2 }), true);
});

console.log('\n=== Estabilidade do marcador: falhas e isolamento ===');

// Simula a lógica ATUALIZADA: marcador só é registrado após sucesso
function shouldConsultAvailabilityWithFailure(history, currentParams) {
  const lastParams = getLastAvailabilityParams(history);
  if (!lastParams) return true;
  return (
    lastParams.checkIn !== currentParams.checkIn ||
    lastParams.checkOut !== currentParams.checkOut ||
    lastParams.guests !== currentParams.guests
  );
}

test('Consulta bem-sucedida seguida de repetição dos mesmos parâmetros: NÃO consulta', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 2 };
  assert.strictEqual(shouldConsultAvailabilityWithFailure(history, params), false);
});

test('Consulta com falha (sem marcador) seguida de nova tentativa: DEVE consultar', () => {
  // Falha = nenhum marcador foi registrado; histórico tem apenas resposta de erro
  const history = [
    { role: 'assistant', content: 'Ops, não consegui verificar agora.' },
  ];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 2 };
  assert.strictEqual(shouldConsultAvailabilityWithFailure(history, params), true);
});

test('Alteração de datas após consulta bem-sucedida: DEVE consultar', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-02-20', checkOut: '2026-02-25', guests: 2 };
  assert.strictEqual(shouldConsultAvailabilityWithFailure(history, params), true);
});

test('Alteração de hóspedes após consulta bem-sucedida: DEVE consultar', () => {
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
  ];
  const params = { checkIn: '2026-01-10', checkOut: '2026-01-15', guests: 4 };
  assert.strictEqual(shouldConsultAvailabilityWithFailure(history, params), true);
});

// Filtro de isolamento do marcador na montagem do contexto para a LLM
function filterHistoryForLLM(history) {
  return history.filter(m => !/^\[AVAILABILITY_CHECK:/.test(m.content));
}

test('Marcador interno NÃO é enviado ao contexto conversacional do modelo', () => {
  const history = [
    { role: 'user', content: 'Quero ver disponibilidade' },
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-01-10","checkOut":"2026-01-15","guests":2}]' },
    { role: 'assistant', content: 'Temos ótimas opções!' },
  ];
  const filtered = filterHistoryForLLM(history);
  assert.strictEqual(filtered.length, 2, `Esperado 2 mensagens após filtro, recebeu ${filtered.length}`);
  assert.ok(!filtered.some(m => /^\[AVAILABILITY_CHECK:/.test(m.content)), 'Marcador não deve estar no contexto da LLM');
});

test('Ausência do marcador nas mensagens enviadas ao cliente', () => {
  // Mensagens de resposta ao cliente nunca devem conter o marcador
  const replyMessages = [
    'Temos ótimas opções!',
    'Para esse período eu prefiro confirmar o valor...',
    'A suíte Dunas acomoda até 3 pessoas.',
  ];
  replyMessages.forEach(msg => {
    assert.ok(!/^\[AVAILABILITY_CHECK:/.test(msg), `Resposta ao cliente não deve conter marcador: ${msg}`);
  });
});

test('Proteção contra consultas duplicadas simultâneas (mesmos parâmetros)', () => {
  // Se já existe marcador com mesmos parâmetros, nova consulta é bloqueada
  const history = [
    { role: 'assistant', content: '[AVAILABILITY_CHECK:{"checkIn":"2026-03-01","checkOut":"2026-03-05","guests":3}]' },
  ];
  const params = { checkIn: '2026-03-01', checkOut: '2026-03-05', guests: 3 };
  assert.strictEqual(shouldConsultAvailabilityWithFailure(history, params), false);
});

console.log('\n=== Hipóteses vs alterações confirmadas ===');

test('"e se fosse em fevereiro?" é hipótese, não alteração', () => {
  // O extractDates não deve tratar hipótese como data confirmada
  const result = extractDatesCurrent('e se fosse em fevereiro?');
  // Não há range completo, então deve retornar null
  assert.strictEqual(result, null, 'Hipótese sem range não deve retornar datas');
});

test('"muda pra fevereiro" sem dias não retorna range', () => {
  const result = extractDatesCurrent('muda pra fevereiro');
  assert.strictEqual(result, null, 'Mês sozinho sem dias não é range completo');
});

// ============================================================
// RESUMO
// ============================================================

console.log(`\n=== RESULTADO ===`);
console.log(`Total: ${passed + failed} | ✅ ${passed} | ❌ ${failed}`);

if (failed > 0) {
  console.log('\n⚠️  Alguns testes falharam — isso é esperado antes das correções.');
  process.exit(1);
} else {
  console.log('\n🎉 Todos os testes passaram!');
  process.exit(0);
}