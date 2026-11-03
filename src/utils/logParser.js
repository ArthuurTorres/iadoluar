// Traduz as linhas de logs/app.log em eventos legíveis para o painel.
// O arquivo continua no formato técnico; a tradução acontece só na leitura.

const LINE_RE = /^\[([^\]]+)\]\s+\[(INFO|WARN|ERROR)\]\s*(.*)$/;

const SCOPE_LABELS = {
  webhook: 'WhatsApp',
  handler: 'Atendimento',
  orchestrator: 'Cérebro da IA',
  handoff: 'Atendimento humano',
  admin: 'Painel',
  server: 'Servidor',
  settings: 'Tempos',
  switch: 'Chave da IA',
  'prompt-history': 'Prompt',
  evolution: 'WhatsApp',
  hospedinn: 'Reservas',
};

// Tom visual: entrada do cliente, saída para o cliente, decisão da IA, sistema, erro.
const RULES = [
  // --- Entrada de mensagens
  { re: /^\[webhook\] Received POST/, category: 'cliente', tone: 'info', title: () => 'Mensagem recebida no WhatsApp' },
  {
    re: /^\[webhook\] Extracted text/,
    category: 'cliente',
    tone: 'info',
    title: (m, c) => (c.text ? `Cliente escreveu: "${shorten(c.text, 120)}"` : 'Texto da mensagem reconhecido'),
  },
  {
    re: /^\[webhook\] Extracted pushName/,
    category: 'cliente',
    tone: 'muted',
    title: (m, c) => (c.pushName ? `Perfil do contato: ${c.pushName}` : 'Perfil do contato identificado'),
  },
  { re: /^\[webhook\] Skipping own message/, category: 'sistema', tone: 'muted', title: () => 'Mensagem do próprio número ignorada' },
  { re: /^\[webhook\] Scheduling handleMessage/, category: 'sistema', tone: 'muted', title: (m, c) => `Aguardando o cliente parar de digitar (${(c && c.pendingParts) || 1} mensagem(ns) agrupada(s))` },
  { re: /^\[webhook\] Calling handleMessage/, category: 'cliente', tone: 'muted', title: () => 'Mensagem encaminhada para a IA' },
  { re: /^\[orchestrator\] Availability request detected/, category: 'ia', tone: 'info', title: () => 'Cliente quer saber disponibilidade' },
  { re: /^\[orchestrator\] No dates extracted, asking user/, category: 'ia', tone: 'info', title: () => 'Sem datas na mensagem: perguntando o período' },
  { re: /^\[orchestrator\] Room count enriched via getRoomTypes/, category: 'ia', tone: 'muted', title: (m, c) => `Acomodações atualizadas pelo sistema de reservas${c && c.roomCount ? ` (${c.roomCount} tipos)` : ''}` },
  { re: /^\[orchestrator\] Region question pending/, category: 'ia', tone: 'muted', title: () => 'Aguardando a resposta do cliente sobre a região' },
  { re: /^\[extractDates\] input/, category: 'ia', tone: 'muted', title: () => 'Procurando datas no texto do cliente' },
  { re: /^\[webhook\] Empty text after extraction/, category: 'cliente', tone: 'warn', title: () => 'Mensagem sem texto (áudio, imagem ou figurinha)' },
  { re: /^\[webhook\] No data field in payload/, category: 'erro', tone: 'warn', title: () => 'Aviso do WhatsApp sem conteúdo útil' },
  { re: /^\[webhook\] Missing key or message/, category: 'erro', tone: 'warn', title: () => 'Aviso do WhatsApp incompleto' },
  { re: /^\[webhook\] No phoneNumber extracted/, category: 'erro', tone: 'warn', title: () => 'Não foi possível identificar o número do contato' },
  { re: /^\[webhook\] Error processing payload/, category: 'erro', tone: 'error', title: () => 'Falha ao processar a mensagem recebida' },

  // --- Processamento
  { re: /^\[handler\] Starting processMessage/, category: 'ia', tone: 'muted', title: () => 'Iniciando o atendimento' },
  { re: /^\[handler\] processMessage returned/, category: 'ia', tone: 'muted', title: (m, c) => `Decisão tomada${c && c.resultType ? `: ${RESULT_LABELS[c.resultType] || c.resultType}` : ''}` },
  { re: /^\[orchestrator\] processMessage called/, category: 'ia', tone: 'muted', title: () => 'IA analisando a conversa' },
  { re: /^\[orchestrator\] processMessage returning/, category: 'ia', tone: 'muted', title: () => 'IA concluiu a análise' },

  // --- Saída
  {
    re: /^\[handler\] Sending reply via Evolution/,
    category: 'resposta',
    tone: 'success',
    title: (m, c) => (c.content ? `Resposta enviada: "${shorten(c.content, 140)}"` : 'Resposta enviada ao cliente'),
  },
  { re: /^\[handler\] Sending multi_reply part via Evolution/, category: 'resposta', tone: 'success', title: (m, c) => (c.content ? `Bloco enviado: "${shorten(c.content, 140)}"` : 'Bloco de resposta enviado') },
  { re: /^\[handler\] Reply sent successfully/, category: 'resposta', tone: 'muted', title: () => 'Entrega confirmada pelo WhatsApp' },
  { re: /^\[handler\] Multi-reply sent successfully/, category: 'resposta', tone: 'muted', title: () => 'Todos os blocos entregues' },
  { re: /^\[handler\] Sending location pin after contextual text/, category: 'resposta', tone: 'info', title: () => 'Enviando a localização da pousada' },
  { re: /^\[handler\] Message silenced/, category: 'sistema', tone: 'muted', title: () => 'Conversa silenciada, sem resposta automática' },
  { re: /^\[handler\] multi_reply part failed/, category: 'erro', tone: 'error', title: () => 'Falha ao enviar um bloco — os seguintes foram cancelados' },
  { re: /^\[handler\] sendText failed/, category: 'erro', tone: 'error', title: () => 'Falha ao enviar o texto pelo WhatsApp' },
  { re: /^\[handler\] sendLocation failed/, category: 'erro', tone: 'error', title: () => 'Falha ao enviar a localização' },
  { re: /^\[handler\] Error handling message/, category: 'erro', tone: 'error', title: () => 'Erro no atendimento desta conversa' },
  { re: /^\[handler\] Queue error/, category: 'erro', tone: 'error', title: () => 'Erro na fila de atendimento' },

  // --- Cérebro da IA / decisões
  { re: /^\[orchestrator\] Audio message detected/, category: 'ia', tone: 'info', title: () => 'Áudio recebido — transcrevendo' },
  { re: /^\[orchestrator\] (Dates extracted|Dates recovered from history|Dates recovered from short range)/, category: 'ia', tone: 'info', title: () => 'Datas da estadia identificadas' },
  { re: /^\[orchestrator\] Dates adjusted to next year/, category: 'ia', tone: 'info', title: () => 'Datas no passado ajustadas para o próximo ano' },
  { re: /^\[orchestrator\] Date validation failed/, category: 'ia', tone: 'warn', title: () => 'Datas informadas não puderam ser validadas' },
  { re: /^\[orchestrator\] No dates found/, category: 'ia', tone: 'info', title: () => 'Sem datas: a IA vai sugerir um período' },
  { re: /^\[orchestrator\] Short date range without month/, category: 'ia', tone: 'info', title: () => 'Período sem mês: a IA vai perguntar qual mês' },
  { re: /^\[orchestrator\] Generic availability query without dates/, category: 'ia', tone: 'muted', title: () => 'Consulta sem datas: histórico não reaproveitado' },
  { re: /^\[orchestrator\] Availability intent detected/, category: 'ia', tone: 'info', title: () => 'Cliente quer saber disponibilidade' },
  { re: /^\[orchestrator\] Guests unknown/, category: 'ia', tone: 'info', title: () => 'Perguntando quantas pessoas vão se hospedar' },
  { re: /^\[orchestrator\] Guest count without composition/, category: 'ia', tone: 'info', title: () => 'Confirmando se há crianças' },
  { re: /^\[orchestrator\] Children without ages/, category: 'ia', tone: 'info', title: () => 'Perguntando a idade das crianças' },
  { re: /^\[orchestrator\] Quote blocked: missing child ages/, category: 'ia', tone: 'warn', title: () => 'Orçamento bloqueado: faltam as idades das crianças' },
  { re: /^\[orchestrator\] Quote intent detected/, category: 'ia', tone: 'info', title: () => 'Cliente pediu valores' },
  { re: /^\[orchestrator\] Quote not available/, category: 'ia', tone: 'warn', title: () => 'Valores indisponíveis para o período — encaminhando a um atendente' },
  { re: /^\[orchestrator\] Availability checked for quote/, category: 'ia', tone: 'success', title: () => 'Disponibilidade consultada para o orçamento' },
  { re: /^\[orchestrator\] Checking availability/, category: 'ia', tone: 'info', title: () => 'Consultando disponibilidade' },
  { re: /^\[orchestrator\] Availability check returned/, category: 'ia', tone: 'success', title: () => 'Disponibilidade retornou' },
  { re: /^\[orchestrator\] LLM promised a check/, category: 'ia', tone: 'success', title: () => 'A IA prometeu consultar e o sistema executou a consulta' },
  { re: /^\[orchestrator\] Confirmation after promise-to-check/, category: 'ia', tone: 'info', title: () => 'Cliente confirmou — consultando disponibilidade' },
  { re: /^\[orchestrator\] Confirmation after availability shown/, category: 'ia', tone: 'info', title: () => 'Cliente confirmou após ver a disponibilidade' },
  { re: /^\[orchestrator\] Confirmation after quote/, category: 'ia', tone: 'info', title: () => 'Cliente confirmou após receber o orçamento' },
  { re: /^\[orchestrator\] Client requested a human agent/, category: 'ia', tone: 'info', title: () => 'Cliente pediu atendimento humano' },
  { re: /^\[orchestrator\] Client confirmed forwarding/, category: 'ia', tone: 'success', title: () => 'Cliente aceitou ser encaminhado a um atendente' },
  { re: /^\[orchestrator\] Handoff pattern without dates/, category: 'ia', tone: 'info', title: () => 'Pedido de reserva sem datas: perguntando antes de encaminhar' },
  { re: /^\[orchestrator\] Number is silenced/, category: 'sistema', tone: 'muted', title: () => 'Número silenciado, sem resposta' },
  { re: /^\[orchestrator\] Calling LLM API/, category: 'ia', tone: 'muted', title: () => 'Consultando o modelo de linguagem' },
  { re: /^\[orchestrator\] LLM API returned/, category: 'ia', tone: 'muted', title: () => 'Modelo respondeu' },
  { re: /^\[orchestrator\] Falling through to LLM path/, category: 'ia', tone: 'muted', title: () => 'Resposta livre gerada pelo modelo' },
  { re: /^\[orchestrator\] Encoding fix failed/, category: 'ia', tone: 'warn', title: () => 'Ajuste de acentuação falhou — texto original mantido' },
  { re: /^\[orchestrator\] Unknown action type/, category: 'ia', tone: 'warn', title: () => 'Tipo de resposta desconhecido' },
  { re: /^\[orchestrator\] LLM call failed/, category: 'erro', tone: 'error', title: () => 'Falha ao consultar o modelo de linguagem' },
  { re: /^\[orchestrator\] LLM_API_KEY not configured/, category: 'erro', tone: 'error', title: () => 'Chave do modelo de linguagem não configurada' },

  // --- Atendimento humano
  { re: /^\[handoff\] Triggered/, category: 'handoff', tone: 'info', title: () => 'Conversa encaminhada para atendimento humano' },
  { re: /^\[handoff\] Contato marcado como atendimento humano/, category: 'handoff', tone: 'info', title: () => 'Contato marcado em atendimento humano' },
  { re: /^\[handoff\] IA reativada/, category: 'handoff', tone: 'success', title: () => 'Conversa devolvida para a IA' },

  // --- Reservas
  { re: /^HospedInn checkAvailability failed/, category: 'erro', tone: 'error', title: () => 'Falha ao consultar disponibilidade no sistema de reservas' },
  { re: /^HospedInn getRoomTypes failed/, category: 'erro', tone: 'error', title: () => 'Falha ao listar as acomodações' },
  { re: /^HospedInn getAccessToken failed/, category: 'erro', tone: 'error', title: () => 'Falha na autenticação do sistema de reservas' },
  { re: /^HospedInn getRoomTypes: no token/, category: 'erro', tone: 'warn', title: () => 'Sistema de reservas sem credencial' },

  // --- Painel
  { re: /^\[admin\] System prompt atualizado/, category: 'admin', tone: 'success', title: () => 'Prompt atualizado pelo painel' },
  { re: /^\[admin\] Prompt restaurado/, category: 'admin', tone: 'success', title: () => 'Versão anterior do prompt restaurada' },
  { re: /^\[prompt-history\] Versão .* registrada/, category: 'admin', tone: 'muted', title: () => 'Nova versão do prompt salva no histórico' },
  { re: /^\[prompt-history\] Versão inicial registrada/, category: 'admin', tone: 'muted', title: () => 'Prompt em vigor registrado no histórico' },
  { re: /^\[prompt-history\] Prompt restaurado de/, category: 'admin', tone: 'success', title: () => 'Prompt restaurado de uma versão anterior' },
  { re: /^\[prompt-history\] Falha ao registrar prompt inicial/, category: 'erro', tone: 'warn', title: () => 'Não foi possível registrar o prompt no histórico' },
  { re: /^\[prompt-history\] Índice ilegível/, category: 'erro', tone: 'warn', title: () => 'Índice do histórico corrompido — recomeçando' },
  { re: /^\[prompt-history\] Versão .* no índice mas sem arquivo/, category: 'erro', tone: 'warn', title: () => 'Versão do histórico sem arquivo correspondente' },
  { re: /^\[admin\] Functions config atualizada/, category: 'admin', tone: 'success', title: () => 'Funções da IA atualizadas pelo painel' },
  { re: /^\[admin\] Memória limpa/, category: 'admin', tone: 'warn', title: () => 'Memória de conversas apagada pelo painel' },
  { re: /^\[admin\] Todas as conversas e handoffs foram apagados/, category: 'admin', tone: 'warn', title: () => 'Todas as conversas foram apagadas' },
  { re: /^\[admin\] Rebuild remoto iniciado/, category: 'admin', tone: 'info', title: () => 'Rebuild da VPS iniciado pelo painel' },
  { re: /^\[admin\] Rebuild remoto concluído/, category: 'admin', tone: 'success', title: () => 'Rebuild da VPS concluído' },
  { re: /^\[admin\] Rebuild remoto falhou/, category: 'erro', tone: 'error', title: () => 'Rebuild da VPS falhou' },
  { re: /^\[admin\] Rebuild falhou/, category: 'erro', tone: 'error', title: () => 'Rebuild falhou' },
  { re: /^\[admin\] Failed to read logs/, category: 'erro', tone: 'error', title: () => 'Falha ao ler os registros' },
  { re: /^\[admin\] Falha ao ler versão do prompt/, category: 'erro', tone: 'error', title: () => 'Falha ao abrir uma versão do prompt' },
  { re: /^\[admin\] Falha ao listar histórico do prompt/, category: 'erro', tone: 'error', title: () => 'Falha ao listar o histórico do prompt' },
  { re: /^\[admin\] Falha ao restaurar prompt/, category: 'erro', tone: 'error', title: () => 'Falha ao restaurar o prompt' },
  { re: /^\[admin\] Falha ao salvar prompt/, category: 'erro', tone: 'error', title: () => 'Falha ao salvar o prompt' },
  { re: /^\[admin\] Falha ao salvar functions/, category: 'erro', tone: 'error', title: () => 'Falha ao salvar as funções' },
  { re: /^\[admin\] Falha ao salvar temporizadores/, category: 'erro', tone: 'error', title: () => 'Falha ao salvar os tempos de conversa' },
  { re: /^\[admin\] Falha ao limpar memória/, category: 'erro', tone: 'error', title: () => 'Falha ao limpar a memória' },
  { re: /^\[admin\] Failed to list conversations/, category: 'erro', tone: 'error', title: () => 'Falha ao listar as conversas' },
  { re: /^\[admin\] Failed to get conversation/, category: 'erro', tone: 'error', title: () => 'Falha ao abrir a conversa' },

  // --- Sistema
  { re: /^\[server\] IA SDR Pousada running on port/, category: 'sistema', tone: 'success', title: (m) => `Servidor no ar${portFrom(m) ? ` na porta ${portFrom(m)}` : ''}` },
  { re: /^\[server\] UNCAUGHT EXCEPTION/, category: 'erro', tone: 'error', title: () => 'Erro inesperado — o servidor continuou no ar' },
  { re: /^\[server\] UNHANDLED REJECTION/, category: 'erro', tone: 'error', title: () => 'Falha assíncrona — o servidor continuou no ar' },
  { re: /^\[server\] ADMIN_TOKEN não configurado/, category: 'erro', tone: 'warn', title: () => 'Token do painel não configurado' },
  { re: /^\[settings\] Temporizadores atualizados/, category: 'admin', tone: 'success', title: () => 'Tempos de conversa atualizados' },
  { re: /^\[switch\]/, category: 'admin', tone: 'info', title: (m) => (/Ia ativada|true/i.test(m) ? 'IA ativada' : 'IA desativada') },
];

const RESULT_LABELS = {
  silence: 'conversa silenciada',
  reply: 'resposta enviada',
  multi_reply: 'resposta em blocos',
  handoff: 'encaminhado a um atendente',
  no_reply: 'sem resposta',
};

function shorten(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function portFrom(message) {
  const match = /port (\d+)/.exec(message || '');
  return match ? match[1] : '';
}

// Separa a mensagem do contexto JSON (o logger anexa o objeto ao final da linha).
function splitContext(rest) {
  const trimmed = rest.trim();
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return { message: trimmed, context: null };

  const candidate = trimmed.slice(firstBrace);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') {
      return { message: trimmed.slice(0, firstBrace).trim(), context: parsed };
    }
  } catch {
    // Contexto truncado (o logger corta em 500 chars): tenta fechar o objeto.
    try {
      const repaired = JSON.parse(`${candidate.slice(0, candidate.lastIndexOf(',') + 1)}"_truncated":true}`);
      return { message: trimmed.slice(0, firstBrace).trim(), context: repaired };
    } catch {
      return { message: trimmed, context: null };
    }
  }
  return { message: trimmed, context: null };
}

function translate(message, context) {
  for (const rule of RULES) {
    if (rule.re.test(message)) {
      return { title: rule.title(message, context || {}), category: rule.category, tone: rule.tone };
    }
  }
  return { title: shorten(message.replace(/^\[[^\]]+\]\s*/, ''), 200), category: 'sistema', tone: 'muted' };
}

function scopeOf(message) {
  const match = /^\[([\w-]+)\]/.exec(message);
  return match ? match[1] : '';
}

// Transforma as linhas cruas em eventos. Linhas de stack trace entram como detalhe do evento anterior.
function parseLines(lines) {
  const entries = [];

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    const match = LINE_RE.exec(raw);

    if (!match) {
      // Continuação (stack trace / mensagem multilinha) do evento anterior.
      const last = entries[entries.length - 1];
      if (last) {
        last.exception = last.exception ? `${last.exception}\n${raw}` : raw;
      }
      continue;
    }

    const [, timestamp, level, rest] = match;
    const { message, context } = splitContext(rest);
    const scope = scopeOf(message);
    const translated = translate(message, context);
    const isError = level === 'ERROR' || translated.tone === 'error';

    entries.push({
      timestamp,
      time: formatTime(timestamp),
      level,
      scope,
      scopeLabel: SCOPE_LABELS[scope] || (scope ? scope : 'Sistema'),
      category: isError ? 'erro' : translated.category,
      tone: isError ? 'error' : level === 'WARN' ? 'warn' : translated.tone,
      title: translated.title,
      contact: contactOf(context),
      detail: detailOf(context),
      raw: raw.trim(),
    });
  }

  return entries;
}

function contactOf(context) {
  if (!context) return null;
  const phone = context.phoneNumber || context.phone || null;
  const name = context.pushName || null;
  if (!phone && !name) return null;
  return { phone: phone ? String(phone) : null, name: name ? String(name) : null };
}

// Resumo do contexto para o "ver detalhes": só o que interessa a quem lê o painel.
function detailOf(context) {
  if (!context) return null;
  const ignored = new Set(['phoneNumber', 'pushName', '_truncated']);
  const parts = [];

  for (const [key, value] of Object.entries(context)) {
    if (ignored.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${LABELS[key] || key}: ${shorten(text, 400)}`);
  }

  return parts.length ? parts.join('\n') : null;
}

const LABELS = {
  text: 'Mensagem',
  content: 'Conteúdo',
  resultType: 'Resultado',
  pendingParts: 'Mensagens agrupadas',
  source: 'Origem',
  length: 'Tamanho',
  chars: 'Caracteres',
  error: 'Erro',
  detail: 'Detalhe',
  message: 'Mensagem',
  stack: 'Rastro técnico',
  phone: 'Contato',
  duration: 'Duração',
};

const CATEGORIES = {
  cliente: 'Cliente',
  resposta: 'Resposta',
  ia: 'IA',
  handoff: 'Atendimento humano',
  admin: 'Painel',
  sistema: 'Sistema',
  erro: 'Erro',
};

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summarize(entries) {
  const counts = { cliente: 0, resposta: 0, ia: 0, handoff: 0, admin: 0, sistema: 0, erro: 0 };
  const contacts = new Set();

  for (const entry of entries) {
    counts[entry.category] = (counts[entry.category] || 0) + 1;
    if (entry.contact && entry.contact.phone) contacts.add(entry.contact.phone);
  }

  return {
    total: entries.length,
    counts,
    contacts: contacts.size,
    categories: CATEGORIES,
  };
}

module.exports = { parseLines, summarize, CATEGORIES };