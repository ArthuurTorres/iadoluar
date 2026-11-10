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
  }
  return db;
}

const stmtGetHistory = () => getDb().prepare(`
  SELECT role, content, timestamp
  FROM conversations
  WHERE phone_number = ?
  ORDER BY timestamp DESC
  LIMIT ?
`);

const stmtInsert = () => getDb().prepare(`
  INSERT INTO conversations (phone_number, role, content, timestamp)
  VALUES (?, ?, ?, ?)
`);

const stmtDeleteExcess = () => getDb().prepare(`
  DELETE FROM conversations
  WHERE phone_number = ?
    AND id NOT IN (
      SELECT id FROM conversations
      WHERE phone_number = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
`);

const stmtClear = () => getDb().prepare(`
  DELETE FROM conversations WHERE phone_number = ?
`);

function getHistory(phoneNumber) {
  const rows = stmtGetHistory().all(phoneNumber, MAX_MESSAGES);
  // Return in chronological order (ASC) for the LLM context
  return rows.reverse().map(r => ({
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
  }));
}

function appendMessage(phoneNumber, role, content) {
  const timestamp = new Date().toISOString();
  const insert = stmtInsert();
  const deleteExcess = stmtDeleteExcess();

  const txn = getDb().transaction(() => {
    insert.run(phoneNumber, role, content, timestamp);
    deleteExcess.run(phoneNumber, phoneNumber, MAX_MESSAGES);
  });
  txn();

  return getHistory(phoneNumber);
}

function clearHistory(phoneNumber) {
  stmtClear().run(phoneNumber);
}

module.exports = { getHistory, appendMessage, clearHistory };