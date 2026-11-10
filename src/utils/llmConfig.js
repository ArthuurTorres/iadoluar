const fs = require('fs');
const path = require('path');
const { info: logInfo } = require('./logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'llm-config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'llm-config-history.json');

// Catálogo de provedores e modelos conhecidos.
// modelInfo: label (nome legível) · ctx (contexto aproximado) · cost ('$'=barato, '$$'=médio, '$$$'=alto)
//             rec: recomendação curta para o atendimento do Casarão do Luar
const SUPPORTED_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiStyle: 'openai',
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', ctx: '128k', cost: '$', rec: 'Melhor custo-benefício para o dia a dia' },
      { id: 'gpt-4o', label: 'GPT-4o', ctx: '128k', cost: '$$$', rec: 'Respostas mais refinadas, custo alto' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', ctx: '1M', cost: '$', rec: 'Contexto grande e barato' },
      { id: 'gpt-4.1', label: 'GPT-4.1', ctx: '1M', cost: '$$', rec: 'Equilíbrio entre qualidade e preço' },
      { id: 'o4-mini', label: 'o4-mini (raciocínio)', ctx: '200k', cost: '$$', rec: 'Bom para cálculos e regras complexas' }
    ]
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiStyle: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', ctx: '200k', cost: '$', rec: 'Rápido e barato para atendimento' },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ctx: '200k', cost: '$$', rec: 'Equilíbrio ideal para conversas' },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', ctx: '200k', cost: '$$$', rec: 'Máxima qualidade, custo elevado' }
    ]
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiStyle: 'openai',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', ctx: '128k', cost: '$', rec: 'Muito rápido via Groq' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', ctx: '128k', cost: '$', rec: 'Baixíssima latência' },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B', ctx: '128k', cost: '$', rec: 'Alternativa open-source' }
    ]
  }
};

// Limites de parâmetros
const LIMITS = {
  temperature: { min: 0, max: 2, step: 0.1 },
  maxTokens: { min: 100, max: 4096, step: 50 }
};

// Configuração padrão (usa env vars como fallback para compatibilidade)
const DEFAULTS = {
  provider: process.env.LLM_PROVIDER || 'openai',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '500', 10),
  updatedAt: new Date().toISOString()
};

/**
 * Lê configuração do disco. Retorna {} se arquivo não existir ou for inválido.
 */
function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Valida e normaliza uma configuração candidata.
 * Retorna objeto válido ou null se inválido.
 */
function validateConfig(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;

  const result = { ...DEFAULTS };

  // Provider
  if (candidate.provider && SUPPORTED_PROVIDERS[candidate.provider]) {
    result.provider = candidate.provider;
  }

  // Model (aceita qualquer string não vazia; validação real acontece no teste)
  if (typeof candidate.model === 'string' && candidate.model.trim()) {
    result.model = candidate.model.trim();
  }

  // Base URL: o que veio no candidato vence. Sem candidato, LLM_BASE_URL do
  // ambiente vale (DEFAULTS já a carrega) — só cai no padrão do provedor quando
  // não há nenhum dos dois, senão a env é silenciosamente ignorada.
  if (typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim()) {
    result.baseUrl = candidate.baseUrl.trim();
  } else if (!process.env.LLM_BASE_URL && result.provider && SUPPORTED_PROVIDERS[result.provider]) {
    result.baseUrl = SUPPORTED_PROVIDERS[result.provider].baseUrl;
  }

  // Temperature
  const temp = Number(candidate.temperature);
  if (Number.isFinite(temp)) {
    result.temperature = Math.min(LIMITS.temperature.max, Math.max(LIMITS.temperature.min, temp));
  }

  // Max Tokens
  const tokens = Number(candidate.maxTokens);
  if (Number.isFinite(tokens)) {
    result.maxTokens = Math.min(LIMITS.maxTokens.max, Math.max(LIMITS.maxTokens.min, Math.round(tokens)));
  }

  result.updatedAt = new Date().toISOString();
  return result;
}

/**
 * Configuração vigente do LLM.
 * Lida do disco a cada chamada para permitir alteração hot sem reinício.
 * Chave API NUNCA está aqui; vem exclusivamente de process.env.LLM_API_KEY.
 */
function getLlmConfig() {
  const stored = readConfigFile();
  const validated = validateConfig(stored);
  return validated || { ...DEFAULTS };
}

/**
 * Salva nova configuração. Retorna config salva ou lança erro se inválida.
 */
function saveLlmConfig(newConfig) {
  const validated = validateConfig(newConfig);
  if (!validated) {
    throw new Error('Configuração inválida: campos obrigatórios ausentes ou fora dos limites');
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(validated, null, 2), 'utf-8');
  logInfo('[llmConfig] Configuração atualizada', { provider: validated.provider, model: validated.model });

  // Adiciona ao histórico
  addToHistory(validated);

  return validated;
}

/**
 * Lê histórico de configurações (últimas 20).
 */
function getHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Adiciona entrada ao histórico (máximo 20, FIFO).
 */
function addToHistory(config) {
  const history = getHistory();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: config.updatedAt,
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens
  };
  history.unshift(entry);
  if (history.length > 20) history.length = 20;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Restaura configuração por ID do histórico.
 * Retorna config restaurada ou null se ID não encontrado.
 */
function restoreFromHistory(id) {
  const history = getHistory();
  const entry = history.find(h => h.id === id);
  if (!entry) return null;

  const restored = validateConfig({
    provider: entry.provider,
    model: entry.model,
    temperature: entry.temperature,
    maxTokens: entry.maxTokens
  });

  if (!restored) return null;
  return saveLlmConfig(restored);
}

/**
 * Verifica se chave API está configurada (sem expor valor).
 */
function hasApiKey() {
  return Boolean(process.env.LLM_API_KEY);
}

/**
 * Estilo de API do provedor: 'anthropic' (endpoint /messages) ou 'openai' (/chat/completions).
 * Provedor desconhecido cai em 'openai', o formato mais difundido.
 */
function getApiStyle(provider) {
  const p = SUPPORTED_PROVIDERS[provider];
  return p && p.apiStyle === 'anthropic' ? 'anthropic' : 'openai';
}

module.exports = {
  getLlmConfig,
  saveLlmConfig,
  getHistory,
  restoreFromHistory,
  hasApiKey,
  getApiStyle,
  validateConfig,
  SUPPORTED_PROVIDERS,
  LIMITS,
  DEFAULTS
};