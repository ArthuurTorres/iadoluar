# Design: IA SDR para Pousada via WhatsApp

**Data:** 2026-10-22
**Status:** Aprovado
**Autor:** Brainstorming colaborativo

## 1. Visão Geral

Sistema de IA que atua como SDR (Sales Development Representative) para atendimento de hóspedes via WhatsApp. A IA pré-qualifica leads, envia catálogo de quartos, verifica disponibilidade no PMS HospedInn e faz handoff para especialista humana quando o hóspede sinaliza intenção de fechamento.

## 2. Arquitetura

Serviço Node.js único rodando na VPS do cliente, conectado à Evolution API (WhatsApp) e ao HospedInn (PMS). Sem banco de dados próprio nesta fase: memória da conversa vive no contexto da LLM, disponibilidade é consultada em tempo real no PMS.

### Fluxo Linear
1. Hóspede manda mensagem → webhook da Evolution API dispara o serviço
2. Serviço consulta LLM com histórico + instruções de SDR
3. LLM decide ação (responder, enviar catálogo, checar vaga ou silenciar)
4. Serviço executa via Evolution API / HospedInn
5. Resposta volta ao hóspede
6. Quando LLM detecta intenção de fechamento → marca `handoff_triggered` e silencia

### Módulos
- **webhook receiver** — Express recebendo eventos da Evolution API
- **orchestrator** — LLM + regras de negócio + debounce
- **adapters** — Evolution API (envio) + HospedInn (consulta)
- **context manager** — memória de conversa por número (JSON local)
- **handoff controller** — controle de números silenciados

## 3. Integração HospedInn (API v3) — VALIDADA

### Autenticação
- **Endpoint:** `POST https://pms.hospedin.com/oauth/token`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Body:** `grant_type=client_credentials&client_id=<ID>&client_secret=<SECRET>`
- **Response:** `{ access_token, token_type: "Bearer", expires_in: 3600 }`
- **Header para requests:** `Authorization: Bearer <token>` + `Accept: application/json`
- ⚠️ O endpoint de auth NÃO tem prefixo `/api/v3/`

### Endpoints Validados

#### Disponibilidade
- **GET** `/api/v3/availabilities?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD`
- Status: ✅ 200 OK
- ⚠️ Usa parâmetros `check_in` / `check_out` (NÃO `filter[start_date]` / `filter[end_date]` como diz a documentação da SPA)
- Response: JSON:API com disponibilidade por noite

#### Tipos de Quarto
- **GET** `/api/v3/room_types`
- Status: ✅ 200 OK
- Response: 8 tipos de quartos da pousada

#### Preços
- **GET** `/api/v3/prices`
- Status: ❌ 403 Forbidden (conta não migrou para nova tarifa)
- **Mitigação:** Preços serão informados manualmente no catálogo PDF; não bloqueia o SDR

#### Quartos / Unidades
- **GET** `/api/v3/rooms` — lista unidades habitacionais
- **GET** `/api/v3/places` — alias de /rooms

#### Reservas
- **GET** `/api/v3/bookings` (alias: `/api/v3/reservations`)
- Paginação cursor-based: `page[size]` + `page[after]`

### Formato das Respostas
- Content-Type: `application/vnd.api+json` (JSON:API spec)
- Paginação: cursor-based (`page[size]` max 100, `page[after]`)
- Campos monetários: em centavos (`daily_cents`, `total_amount`)
- IDs: numéricos para places/guests, prefixed `r_` para reservations

## 4. Envio de Catálogo

- Arquivo PDF hospedado em `/public/catalogo.pdf` na VPS
- Enviado via Evolution API: `POST /message/sendMedia`
- Legenda cordial definida no system prompt da LLM
- Atualização: substituir arquivo no diretório, sem mexer no código

## 5. Handoff para Especialista Humana

- **Gatilho:** Detecção de palavras-chave no texto do hóspede ("quero reservar", "pode confirmar", "vou fechar", etc.)
- **Ação:** IA marca número como `handoff_triggered` em `data/handoffs.json` e PARA de responder
- **Retorno:** Se especialista marcar número em `data/handoff_override.json`, IA volta a responder
- Não há transferência automática de chat; especialista assume manualmente

## 6. Tratamento de Erros

| Cenário | Comportamento |
|---------|--------------|
| HospedInn indisponível (timeout/5xx) | IA responde cordialmente informando instabilidade, loga erro |
| Datas inválidas | LLM pede confirmação antes de consultar PMS |
| Áudio recebido | IA pede para reenviar por texto |
| Múltiplas mensagens seguidas | Debounce de 2s após última mensagem |
| LLM falha (timeout/5xx) | Fallback fixo: "Opa, tô com um probleminha técnico aqui 😅" |
| `/prices` retorna 403 | Ignorado; preços vêm do catálogo PDF |

## 7. Stack e Estrutura

```
ia-sdr-pousada/
├── src/
│   ├── server.js          # Express + webhook Evolution API
│   ├── orchestrator.js     # LLM + regras de negócio
│   ├── adapters/
│   │   ├── evolution.js    # envio de mensagens/media
│   │   └── hospedinn.js    # consulta disponibilidade
│   └── utils/
│       ├── context.js      # memória de conversa (JSON por número)
│       └── handoff.js      # controle handoff_triggered
├── public/
│   └── catalogo.pdf        # catálogo de quartos
├── data/
│   ├── handoffs.json       # números com handoff_triggered
│   └── handoff_override.json
├── logs/
└── .env                    # chaves API, URLs, tokens
```

**Stack:** Node.js 20+, Express, Axios, Anthropic SDK ou OpenAI SDK, JSON local.

## 8. Fases de Implementação

### Fase 1 — MVP (~3 dias)
- Webhook receiver da Evolution API
- Integração LLM com resposta básica
- Envio de catálogo via Evolution API
- Handoff por palavras-chave
- Memória de conversa local

### Fase 2 — Integração PMS (~2 dias)
- Adapter HospedInn com OAuth2
- Consulta de disponibilidade em tempo real
- Debounce de mensagens
- Logs estruturados
- Tratamento completo de erros

## 9. Decisões e Trade-offs

| Decisão | Justificativa |
|---------|--------------|
| Sem banco de dados | YAGNI; JSON local basta para MVP |
| Sem TypeScript | Acelerar MVP; adicionar depois se necessário |
| Catálogo em PDF | Fácil atualização manual; melhor que texto puro no chat |
| Handoff por silêncio | Simples e eficaz; sem transferência complexa de sessão |
| Debounce 2s | Evita respostas fragmentadas sem atrasar demais |
| `/prices` ignorado | Conta não migrada; catálogo PDF supre a necessidade |

## 10. Credenciais (referência)

- **HospedInn client_id:** `app_nlZjhqX1AmIcNhqAQM8LNGvc88XY5BAK`
- **HospedInn client_secret:** `xeAFzkNb65sGr8QP2pkYRJWy5CWm9hcGtVGA8mOfmlA`
- **Evolution API:** Já instalada na VPS do cliente
- **LLM:** A definir (Anthropic ou OpenAI)