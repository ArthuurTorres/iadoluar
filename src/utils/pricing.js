// Tabela de diárias do Casarão do Luar.
// A API do Hospedinn não expõe preço (/prices responde 403), então a cotação
// é calculada aqui — a LLM nunca faz conta.
// Cada faixa vale pela DATA DA NOITE (não pela data do check-in).
const NIGHTLY_RATES = [
  { from: '2026-10-01', to: '2026-11-30', price: 249.9, label: 'Outubro e novembro de 2026' },
  { from: '2026-12-01', to: '2026-12-27', price: 299.9, label: 'Dezembro de 2026' },
  // Janela do Réveillon: CONFIRMAR com o responsável (mínimo de noites também não confirmado).
  { from: '2026-12-28', to: '2027-01-02', price: 499.0, label: 'Réveillon' },
  { from: '2027-01-03', to: '2027-01-31', price: 299.9, label: 'Janeiro de 2027' },
  { from: '2027-02-01', to: '2027-07-31', price: 299.9, label: 'Fevereiro a julho de 2027' },
];

// A diária base cobre 2 hóspedes (casal). Cada hóspede além disso paga por faixa.
const BASE_GUESTS = 2;
const EXTRA_RATES = {
  child3to10: 90.0,
  over10: 120.0, // vale para 3º adulto e para criança acima de 10 anos
  childUpTo2: 0, // isento — CONFIRMAR com o responsável
};

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function findRate(isoDate) {
  return NIGHTLY_RATES.find((r) => isoDate >= r.from && isoDate <= r.to) || null;
}

function formatBRL(value) {
  const fixed = Math.abs(value).toFixed(2);
  const [intPart, cents] = fixed.split('.');
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${withThousands},${cents}`;
}

/**
 * Valor por noite dos hóspedes além do casal.
 * Faixas mistas: os 2 lugares da diária base abatem as tarifas mais altas.
 */
function extraPerNight(adults, childrenAges) {
  const heads = [];
  const total = Number.isFinite(adults) ? adults : 0;
  for (let i = 0; i < total; i += 1) heads.push(EXTRA_RATES.over10);
  for (const age of childrenAges) {
    if (age >= 11) heads.push(EXTRA_RATES.over10);
    else if (age >= 3) heads.push(EXTRA_RATES.child3to10);
    else heads.push(EXTRA_RATES.childUpTo2);
  }
  heads.sort((a, b) => b - a);
  const extras = heads.slice(BASE_GUESTS).reduce((sum, v) => sum + v, 0);
  return Math.max(0, extras);
}

/**
 * Extrai idades de crianças mencionadas no texto.
 * Cobre "5 e 8 anos", "5, 8 e 10 anos" e "crianças de 5 anos".
 */
function extractChildrenAges(text) {
  const source = String(text || '');
  const ages = [];
  // Lista terminada em "anos": captura todos os números da enumeração
  const listMatch = source.match(/((?:\d{1,2})(?:\s*(?:,|e|,?\s+e)\s*\d{1,2})*)\s*anos?\b/i);
  if (listMatch) {
    for (const raw of listMatch[1].match(/\d{1,2}/g) || []) {
      const age = parseInt(raw, 10);
      if (age >= 0 && age <= 17) ages.push(age);
    }
  }
  if (ages.length > 0) return ages;
  // Fallback: "5 anos" isolado
  for (const m of source.matchAll(/(\d{1,2})\s*anos?\b/gi)) {
    const age = parseInt(m[1], 10);
    if (age >= 0 && age <= 17) ages.push(age);
  }
  return ages;
}

/**
 * Calcula a cotação da estadia. Retorna { ok: false, reason } quando não é
 * possível cotar com segurança (fora da tabela, datas inválidas, falta de idade).
 */
function calculateQuote(checkIn, checkOut, adults, childrenAges, options = {}) {
  const totalGuests = (adults || 0) + (childrenAges ? childrenAges.length : 0);
  // Suíte menor que o grupo não pode ser cotada: o cliente pagaria por um quarto onde não cabe.
  if (options.capacity && totalGuests > options.capacity) {
    return { ok: false, reason: 'room_too_small', capacity: options.capacity, totalGuests };
  }
  const inDate = new Date(`${checkIn}T00:00:00`);
  const outDate = new Date(`${checkOut}T00:00:00`);
  if (isNaN(inDate.getTime()) || isNaN(outDate.getTime()) || outDate <= inDate) {
    return { ok: false, reason: 'invalid_dates' };
  }

  const nights = [];
  for (let d = new Date(inDate); d < outDate; d.setDate(d.getDate() + 1)) {
    const iso = toISO(d);
    const rate = findRate(iso);
    if (!rate) return { ok: false, reason: 'outside_table', missingDate: iso };
    nights.push({ date: iso, price: rate.price, label: rate.label });
  }

  const extras = extraPerNight(adults, childrenAges || []);
  const roomsTotal = nights.reduce((sum, n) => sum + n.price, 0);
  const extrasTotal = extras * nights.length;
  const total = roomsTotal + extrasTotal;

  return {
    ok: true,
    nights: nights.length,
    nightlyPrices: nights.map((n) => n.price),
    distinctNightly: [...new Set(nights.map((n) => n.price))],
    averageNightly: total / nights.length,
    extrasPerNight: extras,
    roomsTotal,
    extrasTotal,
    total,
  };
}

function formatDateBR(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Monta a mensagem de cotação. Só entram linhas cujo dado é real.
 */
function formatQuote(quote, { roomName, roomCapacity, checkIn, checkOut, adults, childrenAges }) {
  const guests = [`${adults} ${adults === 1 ? 'adulto' : 'adultos'}`];
  if (childrenAges && childrenAges.length) {
    guests.push(`${childrenAges.length} ${childrenAges.length === 1 ? 'criança' : 'crianças'} (${childrenAges.join(' e ')} anos)`);
  }
  const roomLine = roomName ? `✨ Suíte: ${roomName}${roomCapacity ? ` (até ${roomCapacity} pessoas)` : ''}` : '';
  const nightsLabel = `${quote.nights} ${quote.nights === 1 ? 'noite' : 'noites'}`;
  // Diária do casal é a da tabela; extras aparecem separados para não parecer
  // que o preço anunciado mudou. "Média" só quando a estadia cruza períodos.
  const baseLabel = quote.distinctNightly.length > 1 ? 'Diária média (casal)' : 'Diária (casal)';
  const baseNightly = quote.distinctNightly.length > 1
    ? quote.roomsTotal / quote.nights
    : quote.distinctNightly[0];

  const lines = [
    `📅 Check-in: ${formatDateBR(checkIn)} (a partir das 14h)`,
    `📅 Check-out: ${formatDateBR(checkOut)} (até as 12h)`,
    `🌙 ${nightsLabel}`,
    '',
    `👥 Hóspedes: ${guests.join(' e ')}`,
  ];
  if (roomLine) lines.push(roomLine);
  lines.push('', `💰 ${baseLabel}: ${formatBRL(baseNightly)}`);
  if (quote.extrasPerNight > 0) {
    lines.push(`👤 Hóspedes adicionais: ${formatBRL(quote.extrasPerNight)} por noite`);
  }
lines.push(
    `💳 Total (${nightsLabel}): ${formatBRL(quote.total)}`,
    '',
    '⚠️ Não inclui café da manhã.'
  );
  return lines.join('\n');
}

module.exports = {
  calculateQuote,
  formatQuote,
  extractChildrenAges,
  formatBRL,
  formatDateBR,
  NIGHTLY_RATES,
  EXTRA_RATES,
};