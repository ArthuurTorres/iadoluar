const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Limpa arquivos de teste antes de rodar
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'llm-config-history.json');

function cleanup() {
  try { if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE); } catch {}
  try { if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); } catch {}
}

cleanup();

const {
  getLlmConfig,
  saveLlmConfig,
  getHistory,
  restoreFromHistory,
  hasApiKey,
  validateConfig,
  SUPPORTED_PROVIDERS,
  LIMITS,
  DEFAULTS
} = require('../src/utils/llmConfig');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

// === T1: Configuração padrão quando arquivo não existe ===
test('T1: getLlmConfig retorna defaults quando arquivo não existe', () => {
  cleanup();
  const config = getLlmConfig();
  assert.strictEqual(config.provider, DEFAULTS.provider);
  assert.strictEqual(config.model, DEFAULTS.model);
  assert.strictEqual(config.temperature, DEFAULTS.temperature);
  assert.strictEqual(config.maxTokens, DEFAULTS.maxTokens);
  assert.ok(config.updatedAt);
});

// === T2: Validação aceita config válida ===
test('T2: validateConfig aceita configuração válida', () => {
  const result = validateConfig({
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.5,
    maxTokens: 1000
  });
  assert.ok(result);
  assert.strictEqual(result.provider, 'openai');
  assert.strictEqual(result.model, 'gpt-4o');
  assert.strictEqual(result.temperature, 0.5);
  assert.strictEqual(result.maxTokens, 1000);
});

// === T3: Validação rejeita null/undefined ===
test('T3: validateConfig retorna null para entrada inválida', () => {
  assert.strictEqual(validateConfig(null), null);
  assert.strictEqual(validateConfig(undefined), null);
  assert.strictEqual(validateConfig('string'), null);
});

// === T4: Temperature é clampada dentro dos limites ===
test('T4: temperature fora dos limites é clampada', () => {
  const low = validateConfig({ temperature: -1 });
  assert.strictEqual(low.temperature, LIMITS.temperature.min);

  const high = validateConfig({ temperature: 5 });
  assert.strictEqual(high.temperature, LIMITS.temperature.max);
});

// === T5: maxTokens é clampado dentro dos limites ===
test('T5: maxTokens fora dos limites é clampado', () => {
  const low = validateConfig({ maxTokens: 10 });
  assert.strictEqual(low.maxTokens, LIMITS.maxTokens.min);

  const high = validateConfig({ maxTokens: 99999 });
  assert.strictEqual(high.maxTokens, LIMITS.maxTokens.max);
});

// === T6: Provider inválido cai no default ===
test('T6: provider desconhecido mantém default', () => {
  const result = validateConfig({ provider: 'unknown_provider' });
  assert.strictEqual(result.provider, DEFAULTS.provider);
});

// === T7: saveLlmConfig persiste e lê corretamente ===
test('T7: saveLlmConfig persiste configuração no disco', () => {
  cleanup();
  const saved = saveLlmConfig({
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    temperature: 0.3,
    maxTokens: 800
  });
  assert.strictEqual(saved.provider, 'groq');
  assert.strictEqual(saved.model, 'llama-3.1-8b-instant');

  const loaded = getLlmConfig();
  assert.strictEqual(loaded.provider, 'groq');
  assert.strictEqual(loaded.model, 'llama-3.1-8b-instant');
  assert.strictEqual(loaded.temperature, 0.3);
  assert.strictEqual(loaded.maxTokens, 800);
});

// === T8: saveLlmConfig lança erro para config inválida ===
test('T8: saveLlmConfig lança erro para entrada inválida', () => {
  assert.throws(() => saveLlmConfig(null), /inválida/i);
});

// === T9: Histórico é criado e limitado a 20 entradas ===
test('T9: histórico registra entradas e limita a 20', () => {
  cleanup();
  for (let i = 0; i < 25; i++) {
    saveLlmConfig({ model: `model-${i}`, temperature: 0.1 + (i * 0.01) });
  }
  const history = getHistory();
  assert.strictEqual(history.length, 20);
  // Mais recente primeiro
  assert.ok(history[0].timestamp >= history[19].timestamp);
});

// === T10: restoreFromHistory restaura config por ID ===
test('T10: restoreFromHistory restaura configuração válida', () => {
  cleanup();
  saveLlmConfig({ provider: 'openai', model: 'gpt-4o-mini', temperature: 0.7 });
  saveLlmConfig({ provider: 'groq', model: 'llama-3.3-70b-versatile', temperature: 0.3 });

  const history = getHistory();
  const firstId = history[history.length - 1].id; // entrada mais antiga (openai)

  const restored = restoreFromHistory(firstId);
  assert.ok(restored);
  assert.strictEqual(restored.provider, 'openai');
  assert.strictEqual(restored.model, 'gpt-4o-mini');

  // Config atual deve ser a restaurada
  const current = getLlmConfig();
  assert.strictEqual(current.provider, 'openai');
});

// === T11: restoreFromHistory retorna null para ID inexistente ===
test('T11: restoreFromHistory retorna null para ID inválido', () => {
  const result = restoreFromHistory('nonexistent-id-12345');
  assert.strictEqual(result, null);
});

// === T12: hasApiKey reflete process.env ===
test('T12: hasApiKey detecta presença da chave API', () => {
  const originalKey = process.env.LLM_API_KEY;

  delete process.env.LLM_API_KEY;
  // Recarrega para pegar novo env
  delete require.cache[require.resolve('../src/utils/llmConfig')];
  const mod1 = require('../src/utils/llmConfig');
  assert.strictEqual(mod1.hasApiKey(), false);

  process.env.LLM_API_KEY = 'sk-test-key';
  delete require.cache[require.resolve('../src/utils/llmConfig')];
  const mod2 = require('../src/utils/llmConfig');
  assert.strictEqual(mod2.hasApiKey(), true);

  // Restaura
  if (originalKey !== undefined) {
    process.env.LLM_API_KEY = originalKey;
  } else {
    delete process.env.LLM_API_KEY;
  }
});

// === T13: Base URL é preenchida automaticamente pelo provedor ===
test('T13: baseUrl é preenchida pelo provedor quando omitida', () => {
  const result = validateConfig({ provider: 'anthropic', model: 'claude-3-haiku-20240307' });
  assert.strictEqual(result.baseUrl, SUPPORTED_PROVIDERS.anthropic.baseUrl);
});

// === T14: Model vazio cai no default ===
test('T14: model vazio ou whitespace mantém default', () => {
  const result = validateConfig({ model: '   ' });
  assert.strictEqual(result.model, DEFAULTS.model);
});

// === T15: Arquivo corrompido retorna defaults sem crash ===
test('T15: arquivo JSON corrompido retorna defaults gracefully', () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, '{invalid json!!!', 'utf-8');
  const config = getLlmConfig();
  assert.strictEqual(config.provider, DEFAULTS.provider);
  assert.strictEqual(config.model, DEFAULTS.model);
});

// Resumo
console.log(`\n📊 Resultado: ${passed} passaram, ${failed} falharam de ${passed + failed} testes`);
cleanup();
process.exit(failed > 0 ? 1 : 0);