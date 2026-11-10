const MONTH_MAP = {
  janeiro: '01', fevereiro: '02', março: '03', marco: '03', abril: '04',
  maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09',
  outubro: '10', novembro: '11', dezembro: '12',
  jan: '01', fev: '02', mar: '03', abr: '04', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};
function extractDates(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
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

  // Pattern 4: check-in/check-out labels with ISO or slash dates
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

  // Pattern 5a: "dia DD ate dia DD de MES_A para MES_B" (mês só no final, ex: "dia 30 até o dia 4 de dezembro para janeiro")
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

  // Pattern 5b: "dia DD ate dia DD de MES" ou "DD de MES ate DD [de] MES"
  // Nota: após normalização NFD + remoção de diacríticos, "até" vira "ate" e "–" vira ""
  // O mês após o primeiro dia só é capturado se seguido de espaço+de ou fim (evita confundir "ate" com mês)
  const ptRangeCheckin = normalized.match(/(?:check[-\s]?in\s*|dia\s+)?(\d{1,2})\s+(?:de\s+)?(?:([a-z]+)\s+)?(?:de\s+(\d{4})\s+)?(?:ate|a|-|para)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})(?:\s+de\s+)?([a-z]+)?(?:\s+de\s+(\d{4}))?/);
  if (ptRangeCheckin) {
    const dayIn = ptRangeCheckin[1].padStart(2, '0');
    const dayOut = ptRangeCheckin[4].padStart(2, '0');
    // Se só há um mês na frase (ex: "dia 20 até dia 24 de janeiro"), ele vale para ambas as datas
    const rawMonthIn = ptRangeCheckin[2];
    const rawMonthOut = ptRangeCheckin[5];
    const singleMonth = (!rawMonthIn && rawMonthOut) ? rawMonthOut : rawMonthIn;
    const monthIn = MONTH_MAP[rawMonthIn] || MONTH_MAP[singleMonth];
    const monthOut = MONTH_MAP[rawMonthOut] || monthIn;
    const yearIn = ptRangeCheckin[3] || ptRangeCheckin[6] || String(currentYear);
    const yearOut = ptRangeCheckin[6] || yearIn;
    if (monthIn && monthOut) {
      // Se checkout é mês seguinte e não foi especificado ano, assume próximo ano se necessário
      let finalYearOut = yearOut;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !ptRangeCheckin[6] && !ptRangeCheckin[3]) {
        finalYearOut = String(parseInt(yearIn, 10) + 1);
      }
      return { checkIn: `${yearIn}-${monthIn}-${dayIn}`, checkOut: `${finalYearOut}-${monthOut}-${dayOut}` };
    }
  }

  // Pattern 5c: intervalo de dias SEM mês na própria frase ("virada de ano dia 31 ate dia 03").
  // O mês/ano vem de outro ponto da conversa ("seria para dezembro"). Sem isso a IA volta a
  // perguntar as datas que o cliente já disse — o erro relatado no atendimento.
  const monthMentionRegex = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/g;
  const daysRangeRegex = /(?<![\d/])(\d{1,2})(?![\d/])\s*(?:ate|a)\s*(?:o\s+)?(?:dia\s+)?(\d{1,2})(?![\d/])/g;
  let daysRange;
  while ((daysRange = daysRangeRegex.exec(normalized)) !== null) {
    const dayIn = daysRange[1].padStart(2, '0');
    const dayOut = daysRange[2].padStart(2, '0');
    // Prioriza o mês citado ANTES do intervalo; depois aceita um mês posterior na mesma frase.
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


module.exports={extractDates,buildRangeFromDaysAndMonth};