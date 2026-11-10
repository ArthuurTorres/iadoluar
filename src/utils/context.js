const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'conversations.db');
const MAX_MESSAGES = 20;

let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_phone_number ON conversations(phone_number)
    `);
    // Migration v1: conversation_state table
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_state (
        phone_number TEXT PRIMARY KEY,
        stage TEXT DEFAULT 'greeting',
        check_in TEXT,
        check_out TEXT,
        adults INTEGER,
        children INTEGER,
        children_ages TEXT,
        last_availability TEXT,
        last_quote TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration v1: schema_version tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const hasVersion = db.prepare('SELECT version FROM schema_version WHERE version = 1').get();
    if (!hasVersion) {
      db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    }
    // Migration v2: add selected_room column to conversation_state
    const hasVersion2 = db.prepare('SELECT version FROM schema_version WHERE version = 2').get();
    if (!hasVersion2) {
      const cols = db.prepare("PRAGMA table_info(conversation_state)").all();
      const hasSelectedRoom = cols.some(c => c.name === 'selected_room');
      if (!hasSelectedRoom) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN selected_room TEXT');
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    }
    // Migration v3: add region_asked and region_known columns to conversation_state
    const hasVersion3 = db.prepare('SELECT version FROM schema_version WHERE version = 3').get();
    if (!hasVersion3) {
      const cols = db.prepare("PRAGMA table_info(conversation_state)").all();
      if (!cols.some(c => c.name === 'region_asked')) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN region_asked INTEGER DEFAULT 0');
      }
      if (!cols.some(c => c.name === 'region_known')) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN region_known INTEGER DEFAULT 0');
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (3)').run();
    }
    // Migration v4: add quote_presented column to conversation_state
    const hasVersion4 = db.prepare('SELECT version FROM schema_version WHERE version = 4').get();
    if (!hasVersion4) {
      const cols = db.prepare("PRAGMA table_info(conversation_state)").all();
      if (!cols.some(c => c.name === 'quote_presented')) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN quote_presented INTEGER DEFAULT 0');
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (4)').run();
    }
    // Migration v5: separa orçamento gerado de orçamento apresentado e marca a
    // confirmação do cliente. quote_generated = cálculo gravado;
    // quote_presented = mensagem de fato entregue pela Evolution API;
    // handoff_confirmed = cliente confirmou o resumo da reserva.
    const hasVersion5 = db.prepare('SELECT version FROM schema_version WHERE version = 5').get();
    if (!hasVersion5) {
      const cols = db.prepare("PRAGMA table_info(conversation_state)").all();
      if (!cols.some(c => c.name === 'quote_generated')) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN quote_generated INTEGER DEFAULT 0');
      }
      if (!cols.some(c => c.name === 'handoff_confirmed')) {
        db.exec('ALTER TABLE conversation_state ADD COLUMN handoff_confirmed INTEGER DEFAULT 0');
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (5)').run();
    }
  }
  return db;
}

// --- Conversation history (full retention, LLM window filtered) ---

const stmtGetAllHistory = () => getDb().prepare(`
  SELECT role, content, timestamp
  FROM conversations
  WHERE phone_number = ?
  ORDER BY timestamp ASC
`);

const stmtGetLLMWindow = () => getDb().prepare(`
  SELECT role, content, timestamp
  FROM conversations
  WHERE phone_number = ?
    AND content NOT LIKE '[AVAILABILITY_CHECK:%'
    AND content != '[LOCATION_SENT]'
  ORDER BY timestamp DESC
  LIMIT ?
`);

const stmtInsert = () => getDb().prepare(`
  INSERT INTO conversations (phone_number, role, content, timestamp)
  VALUES (?, ?, ?, ?)
`);

const stmtClearMessages = () => getDb().prepare(`
  DELETE FROM conversations WHERE phone_number = ?
`);

const stmtClearState = () => getDb().prepare(`
  DELETE FROM conversation_state WHERE phone_number = ?
`);

/**
 * Returns the last N messages for LLM context, filtered and in chronological order.
 */
function getHistory(phoneNumber) {
  const rows = stmtGetLLMWindow().all(phoneNumber, MAX_MESSAGES);
  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
  }));
}

/**
 * Returns ALL messages for a phone number (no limit, no filter).
 * Used for hydration and admin inspection.
 */
function getFullHistory(phoneNumber) {
  return stmtGetAllHistory().all(phoneNumber).map(r => ({
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
  }));
}

/**
 * Appends a message. No longer deletes old messages (full retention).
 */
function appendMessage(phoneNumber, role, content) {
  const timestamp = new Date().toISOString();
  stmtInsert().run(phoneNumber, role, content, timestamp);
  return getHistory(phoneNumber);
}

/**
 * Clears both messages and structured state in a single transaction.
 */
function clearHistory(phoneNumber) {
  const txn = getDb().transaction(() => {
    stmtClearMessages().run(phoneNumber);
    stmtClearState().run(phoneNumber);
  });
  txn();
}

// --- Structured state management ---

const STAGES = ['greeting', 'collecting', 'quoting', 'confirming', 'handed_off'];

const stmtGetState = () => getDb().prepare(`
  SELECT phone_number, stage, check_in, check_out, adults, children,
         children_ages, selected_room, last_availability, last_quote, updated_at,
         COALESCE(region_asked, 0) AS region_asked, COALESCE(region_known, 0) AS region_known,
         COALESCE(quote_presented, 0) AS quote_presented,
         COALESCE(quote_generated, 0) AS quote_generated,
         COALESCE(handoff_confirmed, 0) AS handoff_confirmed
  FROM conversation_state
  WHERE phone_number = ?
`);

const stmtUpsertState = () => getDb().prepare(`
  INSERT INTO conversation_state (phone_number, stage, check_in, check_out, adults, children, children_ages, selected_room, last_availability, last_quote, updated_at, region_asked, region_known, quote_presented, quote_generated, handoff_confirmed)
  VALUES (@phone_number, @stage, @check_in, @check_out, @adults, @children, @children_ages, @selected_room, @last_availability, @last_quote, @updated_at, @region_asked, @region_known, @quote_presented, @quote_generated, @handoff_confirmed)
  ON CONFLICT(phone_number) DO UPDATE SET
    stage = COALESCE(@stage, stage),
    check_in = @check_in,
    check_out = @check_out,
    adults = @adults,
    children = @children,
    children_ages = @children_ages,
    selected_room = @selected_room,
    last_availability = @last_availability,
    last_quote = @last_quote,
    updated_at = @updated_at,
    region_asked = @region_asked,
    region_known = @region_known,
    quote_presented = @quote_presented,
    quote_generated = @quote_generated,
    handoff_confirmed = @handoff_confirmed
`);

function rowToState(row) {
  if (!row) return null;
  let childrenAges = null;
  if (row.children_ages) {
    try { childrenAges = JSON.parse(row.children_ages); } catch { childrenAges = null; }
  }
  let lastAvailability = null;
  if (row.last_availability) {
    try { lastAvailability = JSON.parse(row.last_availability); } catch { lastAvailability = null; }
  }
  let lastQuote = null;
  if (row.last_quote) {
    try { lastQuote = JSON.parse(row.last_quote); } catch { lastQuote = null; }
  }
  return {
    phoneNumber: row.phone_number,
    stage: row.stage || 'greeting',
    checkIn: row.check_in || null,
    checkOut: row.check_out || null,
    adults: row.adults != null ? row.adults : null,
    children: row.children != null ? row.children : null,
    childrenAges,
    selectedRoom: row.selected_room || null,
    lastAvailability,
    lastQuote,
    regionAsked: !!row.region_asked,
    regionKnown: !!row.region_known,
    quotePresented: !!row.quote_presented,
    quoteGenerated: !!row.quote_generated,
    handoffConfirmed: !!row.handoff_confirmed,
    updatedAt: row.updated_at,
  };
}

function stateToParams(state) {
  return {
    phone_number: state.phoneNumber,
    stage: state.stage || 'greeting',
    check_in: state.checkIn || null,
    check_out: state.checkOut || null,
    adults: state.adults != null ? state.adults : null,
    children: state.children != null ? state.children : null,
    children_ages: state.childrenAges != null ? JSON.stringify(state.childrenAges) : null,
    selected_room: state.selectedRoom || null,
    last_availability: state.lastAvailability != null ? JSON.stringify(state.lastAvailability) : null,
    last_quote: state.lastQuote != null ? JSON.stringify(state.lastQuote) : null,
    updated_at: new Date().toISOString(),
    region_asked: state.regionAsked ? 1 : 0,
    region_known: state.regionKnown ? 1 : 0,
    quote_presented: state.quotePresented ? 1 : 0,
    quote_generated: state.quoteGenerated ? 1 : 0,
    handoff_confirmed: state.handoffConfirmed ? 1 : 0,
  };
}

/**
 * Extracts guest data (adults, children, ages) from a single text message.
 * Returns a partial state object suitable for merge with updateState().
 * Does NOT persist — caller decides when to call updateState().
 *
 * Patterns mirror guestsFromHistory() in orchestrator.js for consistency:
 * - "2 adultos" / "dois adultos"
 * - "1 criança" / "3 kids"
 * - "somos 4 pessoas" (fallback when no explicit adults/children)
 * - "criança de 6 anos" / "filhos de 5 e 8 anos"
 * - Linguagem natural: "eu e minha esposa", "casal", "nós dois", "eu e meus dois filhos"
 */
function extractGuestsFromText(text) {
  if (!text || typeof text !== 'string') return {};

  const result = {};
  const lower = text.toLowerCase();

  // P1: Linguagem natural brasileira (antes dos parsers numéricos para não serem sobrescritos)
  // Casal / cônjuge → 2 adultos (somente se não houver menção explícita a crianças/filhos)
  const couplePatterns = [
    /eu\s+e\s+(?:minh[ao]|meu)\s+(?:esposa|marido|companheira|companheiro|namorada|namorado)/i,
    /somos\s+(?:um\s+)?casal/i,
    /n[oó]s\s+dois/i,
    /somos\s+dois\s+adultos/i,
  ];
  const hasCouple = couplePatterns.some(p => p.test(text));

  // Filhos/crianças mencionados explicitamente
  const childrenExplicit = /(\d+)\s*(?:filhos?|crian[cç]as?|kids?)/i.test(text);
  const hasChildrenMention = /filhos?|crian[cç]as?|kids?/i.test(text);

	  // "Eu e meus X filhos" ou "eu e minha esposa e meus X filhos" → extrai número de filhos
	  // Aceita dígitos e números por extenso; possessivos meus/nossos/seus/os; texto intermediário opcional
	  const NUM_EXT_MAP = { dois: 2, tres: 3, três: 3, quatro: 4, cinco: 5, seis: 6 };
	  const meAndChildrenRaw = text.match(/(?:meus?|nossos?|seus?|os)\s+(?:(\d+)|(dois|tres|três|quatro|cinco|seis))\s+filhos?/i);
	  const meAndChildren = meAndChildrenRaw ? {
	    1: meAndChildrenRaw[1] || String(NUM_EXT_MAP[meAndChildrenRaw[2]?.toLowerCase()] || 0)
	  } : null;
  // "casal com X filhos" → 2 adultos + X crianças
  const coupleWithChildren = text.match(/casal\s+com\s+(\d+)\s+filhos?/i);
  if (meAndChildren) {
    const childCount = parseInt(meAndChildren[1], 10);
    result.children = childCount;
    // Se há menção a casal/esposa junto, são 2 adultos; senão, 1 adulto
    if (hasCouple) {
      result.adults = 2;
    } else {
      result.adults = 1;
    }
  } else if (coupleWithChildren) {
    const childCount = parseInt(coupleWithChildren[1], 10);
    result.children = childCount;
    result.adults = 2;
  } else if (hasCouple && !childrenExplicit) {
    // Casal sem filhos explícitos → 2 adultos
    result.adults = 2;
  }

  // Adultos (parsers numéricos — só se ainda não definido pela linguagem natural)
  if (result.adults === undefined) {
    const lastAdult = [...text.matchAll(/(\d+)\s*adultos?/gi)].pop();
    const lastDois = [...text.matchAll(/(?:dois|2)\s+adultos?/gi)].pop();
    if (lastAdult && lastAdult[1]) {
      result.adults = parseInt(lastAdult[1], 10);
    } else if (lastDois) {
      result.adults = 2;
    }
  }

  // Fallback: "somos 4 pessoas" (evita "até 4 pessoas" = capacidade de suíte)
  if (result.adults === undefined) {
    const peopleMatch = [...text.matchAll(/(?<!at[ée]\s)(\d+)\s*pessoas?/gi)].pop();
    if (peopleMatch && peopleMatch[1]) {
      result.adults = parseInt(peopleMatch[1], 10);
    }
  }

  // Crianças
  const lastChild = [...text.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)].pop();
  if (lastChild && lastChild[1]) {
    result.children = parseInt(lastChild[1], 10);
  }

  // Idades das crianças: extrai números próximos a 'ano(s)', incluindo padrões como '5 e 8 anos'
  const ageParts = text.split(/\s+/);
  const ages = [];
  for (let i = 0; i < ageParts.length; i++) {
    const num = parseInt(ageParts[i], 10);
    if (isNaN(num)) continue;
    // Verifica se o próximo token é 'anos' ou se há 'e'/'-' seguido de outro número e depois 'anos'
    const next = (ageParts[i + 1] || '').toLowerCase();
    const afterNext = (ageParts[i + 2] || '').toLowerCase();
    const afterAfterNext = (ageParts[i + 3] || '').toLowerCase();
    if (/^anos?$/.test(next)) {
      ages.push(num);
    } else if (/^(?:e|,|-|–)$/.test(next) && !isNaN(parseInt(afterNext, 10)) && /^anos?$/.test(afterAfterNext)) {
      ages.push(num);
    }
  }
  if (ages.length > 0) {
    result.childrenAges = ages;
  }

  return result;
}

/**
 * Hydrates state from full conversation history using regex patterns.
 * Returns a partial state object (not persisted).
 */
function hydrateStateFromHistory(history) {
  const state = {};

  const RANGE_PATTERN = /(?:de\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?\s+(?:a|até|à)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?/i;
  const EXTENSO_PATTERN = /(?:de\s+|dia\s+)?(\d{1,2})\s+(?:a|até|à|-|–)\s+(?:dia\s+)?(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i;
  const MONTH_MAP = { janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
  const ADULTS_PATTERN = /(\d+)\s*(?:adulto|adulta)s?/i;
  const CHILDREN_PATTERN = /(\d+)\s*(?:crian[cç]a|crian[cç]as|menor|menores)/i;
  const AGE_PATTERN = /(\d+)\s*anos?/gi;

  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text = msg.content;

    // Datas por extenso: "15 a 20 de dezembro"
    const extensoMatch = text.match(EXTENSO_PATTERN);
    if (extensoMatch && !state.checkIn) {
      const now = new Date();
      const year = now.getFullYear();
      const m = MONTH_MAP[extensoMatch[3].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
      const d1 = parseInt(extensoMatch[1], 10);
      const d2 = parseInt(extensoMatch[2], 10);
      if (m) {
        const checkIn = `${year}-${String(m).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
        const checkOut = `${year}-${String(m).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
        if (new Date(checkOut) >= new Date(checkIn)) {
          state.checkIn = checkIn;
          state.checkOut = checkOut;
        }
      }
    }

    const rangeMatch = text.match(RANGE_PATTERN);
    if (rangeMatch && !state.checkIn) {
      const now = new Date();
      const year = now.getFullYear();
      const m1 = parseInt(rangeMatch[2], 10);
      const d1 = parseInt(rangeMatch[1], 10);
      const m2 = parseInt(rangeMatch[4], 10);
      const d2 = parseInt(rangeMatch[3], 10);
      const checkIn = `${year}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
      const checkOut = `${year}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
      if (new Date(checkOut) >= new Date(checkIn)) {
        state.checkIn = checkIn;
        state.checkOut = checkOut;
      }
    }

    const adultsMatch = text.match(ADULTS_PATTERN);
    if (adultsMatch) {
      state.adults = parseInt(adultsMatch[1], 10);
    }

    const childrenMatch = text.match(CHILDREN_PATTERN);
    if (childrenMatch) {
      state.children = parseInt(childrenMatch[1], 10);
    }

    // Extrai idades mencionadas: "criança de 6 anos", "filhos de 5 e 8 anos"
    const ageMatches = [...text.matchAll(AGE_PATTERN)];
    if (ageMatches.length > 0) {
      state.childrenAges = ageMatches.map(m => parseInt(m[1], 10));
    }
  }

  const result = {};
  if (state.checkIn) result.checkIn = state.checkIn;
  if (state.checkOut) result.checkOut = state.checkOut;
  if (state.adults != null) result.adults = state.adults;
  if (state.children != null) result.children = state.children;
  if (state.childrenAges != null) result.childrenAges = state.childrenAges;

  return result;
}

/**
 * Gets the structured state for a phone number.
 * If no state exists, hydrates from history and persists the result.
 */
function getState(phoneNumber) {
  const row = stmtGetState().get(phoneNumber);
  if (row) {
    return rowToState(row);
  }

  const history = getFullHistory(phoneNumber);
  const hydrated = hydrateStateFromHistory(history);

  const newState = {
    phoneNumber,
    stage: 'greeting',
    checkIn: hydrated.checkIn || null,
    checkOut: hydrated.checkOut || null,
    adults: hydrated.adults != null ? hydrated.adults : null,
    children: hydrated.children != null ? hydrated.children : null,
    childrenAges: null,
    lastAvailability: null,
    lastQuote: null,
    regionAsked: false,
    regionKnown: false,
    quotePresented: false,
    quoteGenerated: false,
    handoffConfirmed: false,
    updatedAt: new Date().toISOString(),
  };

  const params = stateToParams(newState);
  stmtUpsertState().run(params);

  return newState;
}

/**
 * Validates a partial state update against business rules.
 */
function validatePartial(partial) {
  if (partial.stage != null && !STAGES.includes(partial.stage)) {
    return { valid: false, error: `Invalid stage: ${partial.stage}` };
  }
  if (partial.adults != null && (typeof partial.adults !== 'number' || partial.adults < 0)) {
    return { valid: false, error: `Invalid adults: ${partial.adults}` };
  }
  if (partial.children != null && (typeof partial.children !== 'number' || partial.children < 0)) {
    return { valid: false, error: `Invalid children: ${partial.children}` };
  }
  if (partial.childrenAges != null) {
    if (!Array.isArray(partial.childrenAges)) {
      return { valid: false, error: 'childrenAges must be an array' };
    }
    for (const age of partial.childrenAges) {
      if (typeof age !== 'number' || age < 0 || age > 17) {
        return { valid: false, error: `Invalid child age: ${age}` };
      }
    }
  }
  if (partial.checkIn != null && !/^\d{4}-\d{2}-\d{2}$/.test(partial.checkIn)) {
    return { valid: false, error: `Invalid checkIn format: ${partial.checkIn}` };
  }
  if (partial.checkOut != null && !/^\d{4}-\d{2}-\d{2}$/.test(partial.checkOut)) {
    return { valid: false, error: `Invalid checkOut format: ${partial.checkOut}` };
  }
  return { valid: true };
}

/**
 * Updates structured state with merge semantics and automatic invalidation.
 *
 * Invalidation rules:
 * - checkIn/checkOut/adults/children changed → clears lastAvailability + lastQuote
 * - childrenAges changed → clears lastQuote only
 * - qualquer alteração acima (ou de suíte) invalida o ciclo do orçamento:
 *   quoteGenerated, quotePresented e handoffConfirmed voltam a false, porque o
 *   orçamento que o cliente viu não corresponde mais aos dados da conversa.
 *   A invalidação vence as flags do partial — quem mudou dado não pode marcar
 *   o orçamento antigo como apresentado.
 */
function updateState(phoneNumber, partial) {
  const current = getState(phoneNumber);
  const validation = validatePartial(partial);
  if (!validation.valid) {
    throw new Error(`updateState validation failed: ${validation.error}`);
  }

  const merged = { ...current };
  let datesOrGuestsChanged = false;
  let agesChanged = false;

  if (partial.stage !== undefined) merged.stage = partial.stage;
  if (partial.checkIn !== undefined) {
    if (partial.checkIn !== current.checkIn) datesOrGuestsChanged = true;
    merged.checkIn = partial.checkIn;
  }
  if (partial.checkOut !== undefined) {
    if (partial.checkOut !== current.checkOut) datesOrGuestsChanged = true;
    merged.checkOut = partial.checkOut;
  }
  if (partial.adults !== undefined) {
    if (partial.adults !== current.adults) datesOrGuestsChanged = true;
    merged.adults = partial.adults;
  }
  if (partial.children !== undefined) {
    if (partial.children !== current.children) datesOrGuestsChanged = true;
    merged.children = partial.children;
  }
  if (partial.childrenAges !== undefined) {
    const currentAges = JSON.stringify(current.childrenAges);
    const newAges = JSON.stringify(partial.childrenAges);
    if (currentAges !== newAges) agesChanged = true;
    merged.childrenAges = partial.childrenAges;
  }

  let roomChanged = false;
  if (partial.selectedRoom !== undefined) {
    if (partial.selectedRoom !== current.selectedRoom) roomChanged = true;
    merged.selectedRoom = partial.selectedRoom;
  }

  if (partial.regionAsked !== undefined) merged.regionAsked = !!partial.regionAsked;
  if (partial.regionKnown !== undefined) merged.regionKnown = !!partial.regionKnown;
  if (partial.quotePresented !== undefined) merged.quotePresented = !!partial.quotePresented;
  if (partial.quoteGenerated !== undefined) merged.quoteGenerated = !!partial.quoteGenerated;
  if (partial.handoffConfirmed !== undefined) merged.handoffConfirmed = !!partial.handoffConfirmed;

  // Invalidação só zera o que existe: num estado ainda sem orçamento (hidratação
  // ou primeiro preenchimento) não há proposta antiga para derrubar, então as
  // flags do partial valem. Com orçamento/disponibilidade gravados, mudar dado
  // vence as flags — quem mudou não pode marcar a proposta antiga como entregue.
  const hasStaleQuote = !!(current.lastQuote || current.lastAvailability || current.quoteGenerated || current.quotePresented);
  const quoteInvalidated = hasStaleQuote && (datesOrGuestsChanged || agesChanged || roomChanged);
  if (datesOrGuestsChanged) {
    merged.lastAvailability = null;
    merged.lastQuote = null;
  } else if (quoteInvalidated) {
    merged.lastQuote = null;
  }
  if (quoteInvalidated) {
    merged.quoteGenerated = false;
    merged.quotePresented = false;
    merged.handoffConfirmed = false;
  }

  merged.updatedAt = new Date().toISOString();

  const params = stateToParams(merged);
  stmtUpsertState().run(params);

  return merged;
}

/**
 * Persists availability or quote result atomically, independent of messages.
 */
function persistResult(phoneNumber, type, params, result) {
  if (type !== 'availability' && type !== 'quote') {
    throw new Error(`persistResult: unknown type "${type}"`);
  }

  const entry = {
    params,
    result,
    timestamp: new Date().toISOString(),
  };

  const txn = getDb().transaction(() => {
    const existing = stmtGetState().get(phoneNumber);
    if (!existing) {
      const emptyState = {
        phoneNumber,
        stage: 'greeting',
        checkIn: null,
        checkOut: null,
        adults: null,
        children: null,
        childrenAges: null,
        lastAvailability: null,
        lastQuote: null,
        quotePresented: false,
        quoteGenerated: false,
        handoffConfirmed: false,
        updatedAt: new Date().toISOString(),
      };
      stmtUpsertState().run(stateToParams(emptyState));
    }

    if (type === 'availability') {
      getDb().prepare(`
        UPDATE conversation_state
        SET last_availability = ?, updated_at = ?
        WHERE phone_number = ?
      `).run(JSON.stringify(entry), new Date().toISOString(), phoneNumber);
    } else {
      // Nova cotação nasce gerada e NÃO apresentada: só o envio bem-sucedido
      // pela Evolution API marca quote_presented (ver markQuotePresented).
      getDb().prepare(`
        UPDATE conversation_state
        SET last_quote = ?, quote_generated = 1, quote_presented = 0, handoff_confirmed = 0, updated_at = ?
        WHERE phone_number = ?
      `).run(JSON.stringify(entry), new Date().toISOString(), phoneNumber);
    }
  });

  txn();
}

/**
 * Marca o orçamento como efetivamente entregue ao cliente. Só deve ser chamada
 * depois que o envio ao WhatsApp retornar sucesso — montar a mensagem não é
 * apresentar o orçamento.
 */
function markQuotePresented(phoneNumber) {
  getDb().prepare(`
    UPDATE conversation_state
    SET quote_presented = 1, updated_at = ?
    WHERE phone_number = ? AND quote_generated = 1
  `).run(new Date().toISOString(), phoneNumber);
  return getState(phoneNumber);
}

/**
 * Marca a confirmação do cliente sobre o resumo da reserva.
 */
function markHandoffConfirmed(phoneNumber) {
  getDb().prepare(`
    UPDATE conversation_state
    SET handoff_confirmed = 1, updated_at = ?
    WHERE phone_number = ?
  `).run(new Date().toISOString(), phoneNumber);
  return getState(phoneNumber);
}

/**
 * Diz se o orçamento guardado ainda corresponde aos dados atuais da conversa.
 * Devolve o resultado persistido quando válido, ou null quando não há cotação,
 * ela não foi entregue ou os dados mudaram desde então.
 */
function isQuoteValidFor(phoneNumber, overrides = {}) {
  const state = getState(phoneNumber);
  if (!state.quotePresented || !state.lastQuote || !state.lastQuote.result) return null;

  const params = state.lastQuote.params || {};
  const checkIn = overrides.checkIn !== undefined ? overrides.checkIn : state.checkIn;
  const checkOut = overrides.checkOut !== undefined ? overrides.checkOut : state.checkOut;
  const adults = overrides.adults !== undefined ? overrides.adults : state.adults;
  const childrenAges = overrides.childrenAges !== undefined ? overrides.childrenAges : state.childrenAges;
  // A suíte que vale é a que foi cotada. Quando o cliente não escolheu nenhuma, a cotação
  // usou a recomendação automática e o estado não tem selectedRoom — comparar com null
  // invalidaria toda cotação legítima e o resumo nunca sairia.
  const selectedRoom = overrides.selectedRoom !== undefined ? overrides.selectedRoom : state.selectedRoom;
  const quotedRoom = params.room;

  if (!checkIn || !checkOut || !quotedRoom) return null;
  if (params.checkIn !== checkIn || params.checkOut !== checkOut) return null;
  if (params.adults !== adults) return null;
  if (selectedRoom && selectedRoom !== quotedRoom) return null;
  if (JSON.stringify(params.childrenAges || []) !== JSON.stringify(childrenAges || [])) return null;

  return state.lastQuote;
}

/**
 * Appends a message and updates state in a single atomic transaction.
 */
function appendMessageWithState(phoneNumber, role, content, statePartial) {
  const timestamp = new Date().toISOString();
  const insert = stmtInsert();

  const txn = getDb().transaction(() => {
    insert.run(phoneNumber, role, content, timestamp);

    if (statePartial && Object.keys(statePartial).length > 0) {
      const current = getState(phoneNumber);
      const validation = validatePartial(statePartial);
      if (!validation.valid) {
        throw new Error(`appendMessageWithState validation failed: ${validation.error}`);
      }

      const merged = { ...current };
      let datesOrGuestsChanged = false;
      let agesChanged = false;

      if (statePartial.stage !== undefined) merged.stage = statePartial.stage;
      if (statePartial.checkIn !== undefined) {
        if (statePartial.checkIn !== current.checkIn) datesOrGuestsChanged = true;
        merged.checkIn = statePartial.checkIn;
      }
      if (statePartial.checkOut !== undefined) {
        if (statePartial.checkOut !== current.checkOut) datesOrGuestsChanged = true;
        merged.checkOut = statePartial.checkOut;
      }
      if (statePartial.adults !== undefined) {
        if (statePartial.adults !== current.adults) datesOrGuestsChanged = true;
        merged.adults = statePartial.adults;
      }
      if (statePartial.children !== undefined) {
        if (statePartial.children !== current.children) datesOrGuestsChanged = true;
        merged.children = statePartial.children;
      }
      if (statePartial.childrenAges !== undefined) {
        const currentAges = JSON.stringify(current.childrenAges);
        const newAges = JSON.stringify(statePartial.childrenAges);
        if (currentAges !== newAges) agesChanged = true;
        merged.childrenAges = statePartial.childrenAges;
      }
      let roomChanged = false;
      if (statePartial.selectedRoom !== undefined) {
        if (statePartial.selectedRoom !== current.selectedRoom) roomChanged = true;
        merged.selectedRoom = statePartial.selectedRoom;
      }

      if (statePartial.regionAsked !== undefined) merged.regionAsked = !!statePartial.regionAsked;
      if (statePartial.regionKnown !== undefined) merged.regionKnown = !!statePartial.regionKnown;
      if (statePartial.quotePresented !== undefined) merged.quotePresented = !!statePartial.quotePresented;

      if (datesOrGuestsChanged) {
        merged.lastAvailability = null;
        merged.lastQuote = null;
      } else if (agesChanged || roomChanged) {
        merged.lastQuote = null;
      }

      merged.updatedAt = new Date().toISOString();
      const params = stateToParams(merged);
      stmtUpsertState().run(params);
    }
  });

  txn();
  return getHistory(phoneNumber);
}

module.exports = {
  getHistory,
  getFullHistory,
  appendMessage,
  appendMessageWithState,
  clearHistory,
  getState,
  updateState,
  persistResult,
  markQuotePresented,
  markHandoffConfirmed,
  isQuoteValidFor,
  hydrateStateFromHistory,
  extractGuestsFromText
};