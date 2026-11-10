# Plano de Implementação — IA SDR Pousada (Fase 1 MVP)

**Data:** 2026-10-22
**Base:** Design aprovado em `2026-10-22-ia-sdr-pousada-design.md`
**Escopo:** Webhook receiver, LLM básica, catálogo via Evolution API, handoff por palavras-chave, memória local

---

## Tarefa 1: Estrutura base e dependências

**Arquivos:**
- `package.json` — manifesto Node.js com scripts `start`, `dev`
- `.env.example` — template de variáveis de ambiente (sem secrets reais)
- `.gitignore` — ignorar node_modules, .env, data/*.json, logs/

**Responsabilidade:** Configurar projeto Node.js 20+ com Express, Axios e dotenv como dependências base.

**Critérios de aceite:**
- `npm install` roda sem erros
- `node -e "require('express'); require('axios'); require('dotenv')"` não lança exceção
- `.env.example` lista todas as variáveis necessárias sem valores reais

**Comando de validação:**
```bash
cd .claude/worktrees/ia-sdr-pousada && npm install && node -e "require('express'); console.log('OK')"
```

---

## Tarefa 2: Utilitário de contexto (memória de conversa)

**Arquivo:** `src/utils/context.js`

**Responsabilidade:** Gerenciar histórico de mensagens por número de telefone usando JSON local (`data/conversations/<numero>.json`). Funções exportadas:
- `getHistory(phoneNumber)` → retorna array de mensagens ou `[]`
- `appendMessage(phoneNumber, role, content)` → adiciona mensagem e persiste
- `clearHistory(phoneNumber)` → limpa histórico do número

**Dependências:** Nenhuma (módulo folha)

**Critérios de aceite:**
- Cria arquivo JSON automaticamente se não existir
- Limita histórico a últimas 20 mensagens (evita estouro de contexto LLM)
- Thread-safe para leituras/escritas sequenciais (Node single-thread OK)

**Comando de validação:**
```bash
node -e "
const ctx = require('./src/utils/context');
ctx.appendMessage('5511999999999', 'user', 'teste');
console.log(ctx.getHistory('5511999999999'));
"
```

---

## Tarefa 3: Controlador de handoff

**Arquivo:** `src/utils/handoff.js`

**Responsabilidade:** Gerenciar números silenciados após detecção de intenção de fechamento. Funções:
- `isHandoffTriggered(phoneNumber)` → boolean
- `triggerHandoff(phoneNumber)` → marca em `data/handoffs.json`
- `isOverrideActive(phoneNumber)` → checa `data/handoff_override.json`
- `shouldSilence(phoneNumber)` → `isHandoffTriggered(p) && !isOverrideActive(p)`

**Dependências:** Nenhuma (módulo folha)

**Critérios de aceite:**
- Arquivos JSON criados vazios (`{}`) se não existirem
- Retorna `false` gracefully para números não registrados
- Override remove silêncio sem apagar handoff original

**Comando de validação:**
```bash
node -e "
const h = require('./src/utils/handoff');
h.triggerHandoff('5511999999999');
console.log('silenced:', h.shouldSilence('5511999999999'));
"
```

---

## Tarefa 4: Adapter Evolution API (envio)

**Arquivo:** `src/adapters/evolution.js`

**Responsabilidade:** Encapsular chamadas à Evolution API. Funções:
- `sendText(phoneNumber, text)` → POST `/message/sendText`
- `sendMedia(phoneNumber, filePath, caption)` → POST `/message/sendMedia` (multipart/form-data)

**Variáveis de ambiente:** `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`

**Dependências:** axios, dotenv

**Critérios de aceite:**
- Retorna objeto `{ success: boolean, error?: string }` sem lançar exceção
- Loga erro em `logs/evolution.log` com timestamp e payload sanitizado
- Timeout configurável via env (`EVOLUTION_TIMEOUT_MS`, default 10000)

**Comando de validação:**
```bash
node -e "
require('dotenv').config();
const evo = require('./src/adapters/evolution');
console.log(typeof evo.sendText, typeof evo.sendMedia);
"
```

---

## Tarefa 5: Orchestrator (LLM + regras)

**Arquivo:** `src/orchestrator.js`

**Responsabilidade:** Receber mensagem do hóspede, montar prompt com system instructions + histórico, chamar LLM, decidir ação. Função principal:
- `processMessage(phoneNumber, incomingText)` → retorna `{ type: 'reply'|'catalog'|'handoff'|'silence', content?: string }`

**System prompt embutido:** Instruções de SDR cordial, gatilhos de catálogo ("ver quartos", "catálogo", "preços"), gatilhos de handoff ("quero reservar", "pode confirmar", "vou fechar"), regra de áudio ("reenvie por texto").

**Detecção de handoff:** Regex simples sobre texto do hóspede ANTES de chamar LLM (palavras-chave do design doc). Se detectar, chama `handoff.triggerHandoff()` e retorna `{ type: 'handoff' }`.

**Dependências:** `src/utils/context.js`, `src/utils/handoff.js`, axios (para LLM API)

**Variáveis de ambiente:** `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`

**Critérios de aceite:**
- Responde fallback fixo se LLM falhar (timeout/5xx)
- Não chama LLM se handoff já triggered (silêncio imediato)
- Histórico limitado a 20 turnos passado ao modelo
- Retorna tipo de ação estruturado, nunca string solta

**Comando de validação:**
```bash
node -e "
require('dotenv').config();
const orch = require('./src/orchestrator');
console.log(typeof orch.processMessage);
"
```

---

## Tarefa 6: Webhook receiver (Express server)

**Arquivo:** `src/server.js`

**Responsabilidade:** Endpoint HTTP que recebe webhooks da Evolution API. Rota:
- `POST /webhook/evolution` → valida origem, extrai mensagem, chama orchestrator, executa ação via adapter

**Fluxo:**
1. Recebe payload da Evolution API
2. Extrai `phoneNumber` e `text` do body (formato Evolution API)
3. Checa `handoff.shouldSilence(phoneNumber)` → se true, responde 200 sem ação
4. Chama `orchestrator.processMessage(phoneNumber, text)`
5. Executa ação: `sendText` / `sendMedia(catalogo.pdf)` / nada (silence)
6. Responde 200 sempre (Evolution API espera ack rápido)

**Configuração:**
- Porta via `PORT` env (default 3000)
- Body parser JSON
- Health check: `GET /health` → `{ status: 'ok' }`

**Dependências:** express, todos os módulos anteriores

**Critérios de aceite:**
- Servidor sobe sem erros com `npm start`
- `/health` retorna 200
- Webhook ignora payloads sem campo de mensagem válido
- Debounce: se múltiplas mensagens chegarem em <2s, só processa a última (timer resetável)

**Comando de validação:**
```bash
npm start &
sleep 2
curl http://localhost:3000/health
kill %1
```

---

## Ordem de Implementação (grafo de dependências)

```
Tarefa 1 (estrutura)
  ├── Tarefa 2 (context) ──┐
  ├── Tarefa 3 (handoff) ──┤
  └── Tarefa 4 (evolution) ┤
                            ├── Tarefa 5 (orchestrator)
                            │         │
                            └─────────┴── Tarefa 6 (server)
```

Tarefas 2, 3 e 4 são independentes entre si e podem ser implementadas em paralelo.
Tarefa 5 depende de 2, 3 e 4.
Tarefa 6 depende de 5.

---

## Variáveis de Ambiente (.env.example)

```
# Evolution API
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=sua-chave-aqui
EVOLUTION_INSTANCE_NAME=pousada-instance
EVOLUTION_TIMEOUT_MS=10000

# LLM
LLM_API_KEY=sk-sua-chave
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1

# Server
PORT=3000
NODE_ENV=development
```

---

## Notas de Segurança

- **Nunca commitar `.env`** — apenas `.env.example`
- Credenciais HospedInn do design doc são referência; armazenar APENAS em `.env` ou vault
- Logs devem sanitizar números de telefone (mask: `5511*****9999`)
- Webhook deve validar assinatura/token da Evolution API se disponível