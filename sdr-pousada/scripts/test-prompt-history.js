/*
 * Histórico de versões do system prompt: gravação, deduplicação, reversão
 * e endpoints HTTP do painel (listar, ler versão e restaurar).
 * Roda em diretório isolado; não toca no prompt nem no histórico reais.
 * Roda com: node scripts/test-prompt-history.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SANDBOX = path.join(ROOT, '.tmp-prompt-history');
const PROMPT_FILE = path.join(SANDBOX, 'system-prompt.txt');
const HISTORY_DIR = path.join(SANDBOX, 'prompt-history');
const SERVER_PORT = 5999;
const ADMIN_TOKEN = 'test-token-prompt-history';

process.env.PROMPT_DATA_DIR = SANDBOX;
const promptHistory = require('../src/utils/promptHistory');

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
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });

  console.log('=== módulo de histórico ===');

  check('registrar versão cria arquivo e item no índice', () => {
    const { created, version } = promptHistory.recordVersion('Prompt de teste v1\nlinha dois', {
      source: 'test',
      force: true,
    });
    assert.strictEqual(created, true);
    assert.ok(version.id);
    assert.strictEqual(version.length, 'Prompt de teste v1\nlinha dois'.length);
    assert.strictEqual(promptHistory.listVersions().length, 1);
    assert.ok(fs.existsSync(path.join(HISTORY_DIR, `${version.id}.txt`)));
  });

  check('conteúdo guardado é idêntico ao original', () => {
    const text = 'Conteúdo com acentuação: ação, coração, ñ\nsegunda linha';
    const { version } = promptHistory.recordVersion(text, { source: 'test', force: true });
    assert.strictEqual(promptHistory.getVersion(version.id).content, text);
  });

  check('salvamento idêntico ao anterior não duplica versão', () => {
    promptHistory.recordVersion('Repetido', { source: 'test', force: true });
    const count = promptHistory.listVersions().length;
    const result = promptHistory.recordVersion('Repetido', { source: 'test' });
    assert.strictEqual(result.created, false);
    assert.strictEqual(promptHistory.listVersions().length, count);
  });

  check('versão inexistente retorna null', () => {
    assert.strictEqual(promptHistory.getVersion('nao-existe-123'), null);
    assert.strictEqual(promptHistory.getVersion('../../etc/passwd'), null);
  });

  check('hash é estável e detecta mudança', () => {
    assert.strictEqual(promptHistory.sha256('abc'), promptHistory.sha256('abc'));
    assert.notStrictEqual(promptHistory.sha256('abc'), promptHistory.sha256('abd'));
  });

  check('lista vem da mais recente para a mais antiga', () => {
    const older = promptHistory.recordVersion('mais antiga', { source: 'test', force: true }).version;
    const newer = promptHistory.recordVersion('mais nova', { source: 'test', force: true }).version;
    const list = promptHistory.listVersions();
    assert.strictEqual(list[0].id, newer.id, 'a mais recente vem primeiro');
    assert.ok(
      list.findIndex((v) => v.id === newer.id) < list.findIndex((v) => v.id === older.id),
      'a versão gravada depois deve aparecer antes na lista'
    );
  });

  check('savePrompt grava no arquivo e no histórico', () => {
    promptHistory.savePrompt('Prompt gravado pelo savePrompt', { source: 'test', force: true });
    assert.strictEqual(promptHistory.readPrompt(), 'Prompt gravado pelo savePrompt');
    const list = promptHistory.listVersions();
    assert.strictEqual(list[0].sha256, promptHistory.sha256('Prompt gravado pelo savePrompt'));
  });

  check('restaurar versão antiga repõe o texto e preserva o estado anterior', () => {
    const alvo = promptHistory.recordVersion('VERSÃO ALVO DA REVERSÃO', { source: 'test', force: true }).version;
    promptHistory.savePrompt('Versão ruim que precisa ser revertida', { source: 'test', force: true });

    const { restoredFrom, version } = promptHistory.restoreVersion(alvo.id);
    assert.strictEqual(restoredFrom, alvo.id);
    assert.strictEqual(promptHistory.readPrompt(), 'VERSÃO ALVO DA REVERSÃO');
    assert.notStrictEqual(version.id, alvo.id);

    const textos = promptHistory.listVersions().map((v) => promptHistory.getVersion(v.id).content);
    assert.ok(
      textos.includes('Versão ruim que precisa ser revertida'),
      'o texto anterior deve continuar no histórico para desfazer a reversão'
    );
  });

  check('restaurar id inexistente lança NOT_FOUND', () => {
    assert.throws(
      () => promptHistory.restoreVersion('inexistente-999'),
      (err) => err.code === 'NOT_FOUND'
    );
  });

  check('descarta as versões mais antigas acima do limite', () => {
    fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
    const total = promptHistory.MAX_VERSIONS + 5;
    let firstId = null;
    for (let i = 0; i < total; i += 1) {
      const { version } = promptHistory.recordVersion(`versão número ${i}`, { source: 'test', force: true });
      if (i === 0) firstId = version.id;
    }
    const list = promptHistory.listVersions();
    assert.strictEqual(list.length, promptHistory.MAX_VERSIONS);
    assert.strictEqual(promptHistory.getVersion(firstId), null);
    assert.ok(!fs.existsSync(path.join(HISTORY_DIR, `${firstId}.txt`)), 'arquivo antigo deve ser removido');
  });

  console.log('\n=== endpoints do painel ===');

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(PROMPT_FILE, 'Prompt inicial do servidor de teste', 'utf-8');

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROMPT_DATA_DIR: SANDBOX,
      PORT: String(SERVER_PORT),
      ADMIN_TOKEN,
      EVOLUTION_API_URL: 'http://127.0.0.1:5997',
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
    await checkAsync('histórico exige token', async () => {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/admin/prompt/history`);
      assert.strictEqual(res.status, 401);
    });

    await checkAsync('boot registra o prompt em vigor no histórico', async () => {
      const res = await request('GET', '/admin/prompt/history');
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.versions.length >= 1, 'o boot deve gravar a versão inicial');
    });

    await checkAsync('POST /admin/prompt grava e versiona', async () => {
      const res = await request('POST', '/admin/prompt', { prompt: 'Prompt salvo via endpoint', note: 'teste' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.ok, true);
      assert.ok(res.json.version.id);
      assert.strictEqual(promptHistory.readPrompt(), 'Prompt salvo via endpoint');
    });

    let primeiraVersao = null;
    await checkAsync('GET /admin/prompt/history lista e marca a versão em vigor', async () => {
      const res = await request('GET', '/admin/prompt/history');
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.versions.length >= 2);
      assert.strictEqual(res.json.versions[0].sha256, res.json.currentSha256);
      primeiraVersao = res.json.versions[res.json.versions.length - 1];
    });

    await checkAsync('GET /admin/prompt/history/:id devolve o conteúdo', async () => {
      const res = await request('GET', `/admin/prompt/history/${primeiraVersao.id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.version.content, 'Prompt inicial do servidor de teste');
      assert.strictEqual(res.json.version.sha256, primeiraVersao.sha256);
    });

    await checkAsync('GET de versão inexistente devolve 404', async () => {
      const res = await request('GET', '/admin/prompt/history/nao-existe-000');
      assert.strictEqual(res.status, 404);
    });

    await checkAsync('POST /admin/prompt/restore reverte o prompt', async () => {
      const alvo = promptHistory.recordVersion('TEXTO PARA ONDE VOU VOLTAR', { source: 'test', force: true }).version;
      await request('POST', '/admin/prompt', { prompt: 'TEXTO ERRADO QUE SERÁ REVERTIDO' });

      const res = await request('POST', '/admin/prompt/restore', { id: alvo.id });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.restoredFrom, alvo.id);
      assert.strictEqual(promptHistory.readPrompt(), 'TEXTO PARA ONDE VOU VOLTAR');
    });

    await checkAsync('GET /admin/prompt devolve o texto restaurado', async () => {
      const res = await request('GET', '/admin/prompt');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.prompt, 'TEXTO PARA ONDE VOU VOLTAR');
    });

    await checkAsync('restore sem id devolve 400', async () => {
      const res = await request('POST', '/admin/prompt/restore', {});
      assert.strictEqual(res.status, 400);
    });

    await checkAsync('restore de id inexistente devolve 404', async () => {
      const res = await request('POST', '/admin/prompt/restore', { id: 'inexistente-999' });
      assert.strictEqual(res.status, 404);
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