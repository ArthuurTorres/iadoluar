/*
 * Logs legíveis: tradução das linhas cruas em eventos com categoria, contato
 * e resumo, e o endpoint /admin/logs que o painel consome.
 * Roda com: node scripts/test-log-events.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_PORT = 5996;
const ADMIN_TOKEN = 'test-token-logs';
const SANDBOX = path.join(ROOT, '.tmp-log-events');

const { parseLines, summarize } = require('../src/utils/logParser');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FALHOU  ${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FALHOU  ${name}: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function request(method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  console.log('=== tradução dos logs ===');

  check('linha de mensagem recebida vira evento do cliente com o texto', () => {
    const entries = parseLines([
      '[2026-10-31T19:56:31.595Z] [INFO] [webhook] Extracted text {"phoneNumber":"5511999","text":"quero reservar"}',
    ]);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].category, 'cliente');
    assert.strictEqual(entries[0].contact.phone, '5511999');
    assert.ok(entries[0].title.includes('quero reservar'), 'o texto do cliente deve aparecer no título');
  });

  check('resposta enviada vira evento de resposta com o conteúdo', () => {
    const [entry] = parseLines([
      '[2026-10-31T19:56:32.000Z] [INFO] [handler] Sending reply via Evolution {"phoneNumber":"5511999","content":"Temos sim!"}',
    ]);
    assert.strictEqual(entry.category, 'resposta');
    assert.ok(entry.title.includes('Temos sim!'));
  });

  check('erro do nível ERROR vira categoria de erro mesmo sem regra específica', () => {
    const [entry] = parseLines([
      '[2026-10-31T19:56:33.000Z] [ERROR] [handler] mensagem nunca vista antes',
    ]);
    assert.strictEqual(entry.category, 'erro');
    assert.strictEqual(entry.tone, 'error');
  });

  check('mensagem desconhecida é humanizada, sem códigos de colchete', () => {
    const [entry] = parseLines([
      '[2026-10-31T19:56:34.000Z] [INFO] [orchestrator] ',
    ]);
    assert.ok(!entry.title.includes('['), 'o título não deve mostrar o marcador entre colchetes');
  });

  check('stack trace é anexada ao evento anterior em vez de virar evento solto', () => {
    const entries = parseLines([
      '[2026-10-31T19:56:35.000Z] [ERROR] [server] UNCAUGHT EXCEPTION - server kept alive Error: listen EADDRINUSE',
      '    at Server.setupListenHandle (node:net:1939:16)',
    ]);
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].exception.includes('at Server.setupListenHandle'));
  });

  check('contexto truncado pelo logger não perde o texto principal', () => {
    const [entry] = parseLines([
      '[2026-10-31T19:56:36.000Z] [INFO] [webhook] Extracted text {"phoneNumber":"5511999","text":"oi","pushName":"Arthur Torres"',
    ]);
    assert.strictEqual(entry.contact.phone, '5511999');
    assert.ok(entry.title.includes('oi'));
  });

  check('resumo conta por categoria e contatos distintos', () => {
    const entries = parseLines([
      '[2026-10-31T19:56:37.000Z] [INFO] [webhook] Extracted text {"phoneNumber":"A1","text":"oi"}',
      '[2026-10-31T19:56:37.100Z] [INFO] [handler] Sending reply via Evolution {"phoneNumber":"A1","content":"ola"}',
      '[2026-10-31T19:56:37.200Z] [ERROR] [handler] sendText failed for A1: timeout',
    ]);
    const summary = summarize(entries);
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.counts.cliente, 1);
    assert.strictEqual(summary.counts.resposta, 1);
    assert.strictEqual(summary.counts.erro, 1);
    assert.strictEqual(summary.contacts, 1);
  });

  check('log real do projeto é traduzido sem códigos crus no título', () => {
    const logPath = path.join(ROOT, 'logs', 'app.log');
    assert.ok(fs.existsSync(logPath), 'precisa do app.log para este teste');
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').slice(-400);
    const entries = parseLines(lines);
    assert.ok(entries.length > 0);
    const semTraducao = entries.filter((e) => /^\[[\w-]+\]/.test(e.title));
    assert.strictEqual(semTraducao.length, 0, 'nenhum título deve manter o marcador [escopo]');
  });

  console.log('\n=== endpoint do painel ===');

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, 'system-prompt.txt'), 'Prompt do teste de logs', 'utf-8');

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROMPT_DATA_DIR: SANDBOX,
      PORT: String(SERVER_PORT),
      ADMIN_TOKEN,
      EVOLUTION_API_URL: 'http://127.0.0.1:5995',
      EVOLUTION_API_KEY: 'mock-key',
      EVOLUTION_INSTANCE: 'mock',
      HUMAN_DELAY_MS: '0',
      TYPING_DELAY_MS: '0',
      INTER_MESSAGE_DELAY_MS: '0',
      DEBOUNCE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  await sleep(2500);

  try {
    await checkAsync('/admin/logs exige token', async () => {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/admin/logs`);
      assert.strictEqual(res.status, 401);
    });

    await checkAsync('/admin/logs devolve eventos legíveis e o resumo', async () => {
      const res = await request('GET', '/admin/logs');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.json.entries), 'entries deve ser lista');
      assert.ok(Array.isArray(res.json.logs), 'logs cru continua existindo para compatibilidade');
      assert.ok(res.json.entries.length > 0, 'o boot grava eventos');
      assert.ok(res.json.summary && res.json.summary.total === res.json.entries.length);
      const primeiro = res.json.entries[0];
      for (const campo of ['time', 'title', 'category', 'tone']) {
        assert.ok(primeiro[campo], `evento precisa do campo ${campo}`);
      }
    });

    await checkAsync('/admin/logs não expõe telefone sem máscara', async () => {
      const res = await request('GET', '/admin/logs');
      const semMascara = res.json.entries.filter((e) => e.contact && e.contact.phone && !e.contact.phone.includes('*'));
      assert.strictEqual(semMascara.length, 0, 'telefones devem chegar mascarados');
    });
  } finally {
    server.kill();
    await sleep(300);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log('\n--- log do servidor (últimas linhas) ---');
    console.log(serverLog.split('\n').slice(-20).join('\n'));
  }

  console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.error('Erro no teste:', err.message);
  process.exit(1);
});