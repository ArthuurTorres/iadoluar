const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHistory, appendMessage } = require('./utils/context');
const { shouldSilence, triggerHandoff, isHandoffTriggered } = require('./utils/handoff');
const { getSettings } = require('./utils/settings');
const { calculateQuote, formatQuote, extractChildrenAges, formatBRL } = require('./utils/pricing');
const { checkAvailability, getRoomTypes } = require('./adapters/hospedinn');
const { info: logInfo, warn: logWarn, error: logError } = require('./utils/logger');

// Caminho do arquivo de prompt externo (editável via painel admin)
const SYSTEM_PROMPT_FILE = path.join(__dirname, '..', 'data', 'system-prompt.txt');

const HANDOFF_PATTERNS = [
  /quero\s+reservar/i,
  /pode\s+confirmar/i,
  /vou\s+fechar/i,
  /quero\s+fechar/i,
  /confirmar\s+reserva/i,
  /fazer\s+reserva/i,
  /reservar\s+agora/i,
  /fechar\s+agora/i,
  /quero\s+o\s+quarto/i,
  /garantir\s+reserva/i,
];

// Cliente pediu explicitamente uma pessoa: o atendimento humano assume na hora
const REQUEST_HUMAN_PATTERN = /(?:falar|conversar)\s+com\s+(?:um\s+|uma\s+)?(?:humano|atendente|pessoa|algu[eé]m|respons[aá]vel)|atendimento\s+humano|quero\s+(?:um\s+)?atendente|(?:me\s+)?passa\s+(?:para|pra)\s+(?:um\s+)?(?:humano|atendente)|chama\s+(?:um\s+)?(?:humano|atendente)/i;

// Resposta da IA que encerra o atendimento passando a conversa para o especialista
const HANDOFF_SENT_PATTERN = /(?:estou|vou)\s+encaminhando|encaminhando\s+(?:agora|sua reserva|seu atendimento|para)|transferindo\s+(?:voc[eê]|sua conversa)|(?:especialista|atendente|equipe)\s+(?:vai|ir[aá])\s+(?:te\s+)?(?:confirmar|entrar em contato)/i;

const AVAILABILITY_PATTERN = /disponib|\btem\s+vaga|\bvagas?\b|quarto\s+livre|datas\s+de\s+entrada|check[-\s]?in/i;
// Detecta confirmações curtas que devem disparar consulta pendente quando já há dados completos no histórico
const CONFIRMATION_PATTERN = /^(?:sim|isso|correto|confirmo|pode|claro|ok|ta|tá|exato|certinho|confirmado)$/i;

const AUDIO_PATTERN = /(?:^|\s)(?:audio|áudio|voz)\s*$/i;

// Texto que precede o pin: endereço ou diferenciais da pousada/região
const LOCATION_CONTEXT_PATTERN = /pra[cç]a bandeira|rua dos tri[aâ]ngulos|endereço|500 metros|praia do forte|polo gastron|bairro da passagem|[aá]guas cristalinas|p[oô]r do sol|canal itajuru|gastron[oô]mico|curiosidade|sabia que|imperd[ií]vel|vale a pena|encantador|charme|vibe|clima acolhedor|para[í]so|lugar especial/i;

// Catálogo de suítes com links do WhatsApp e capacidade máxima
// A IA deve recomendar a suíte com MENOR capacidade que ainda comporte o grupo (best fit)
const ROOM_CATALOG = [
  { name: 'Conchas', capacity: 2, link: 'https://wa.me/p/32911552961792836/5522992659153' },
  { name: 'Dunas', capacity: 3, link: 'https://wa.me/p/32628577176790968/5522992659153' },
  { name: 'Japonês', capacity: 3, link: 'https://wa.me/p/32841139892197449/5522992659153' },
  { name: 'Brava', capacity: 3, link: 'https://wa.me/p/33205624585702609/5522992659153' },
  { name: 'Peró', capacity: 4, link: 'https://wa.me/p/25150464677925982/5522992659153' },
  { name: 'Foguete', capacity: 6, link: 'https://wa.me/p/25812829871647295/5522992659153' },
  { name: 'Siqueira', capacity: 6, link: 'https://wa.me/p/25329007526750094/5522992659153' },
  { name: 'Forte', capacity: 10, link: 'https://wa.me/p/25258039043853224/5522992659153' },
];

/**
 * Recomenda suítes do catálogo baseadas no número total de hóspedes.
 * Retorna as suítes cuja capacidade >= totalGuests, ordenadas por capacidade ascendente (best fit primeiro).
 * Se totalGuests não for informado, retorna todas ordenadas por capacidade.
 */
function recommendRooms(totalGuests, availableRoomNames) {
  let candidates = ROOM_CATALOG.slice();

  // Filtra apenas suítes disponíveis (se a lista de disponíveis foi fornecida)
  if (availableRoomNames && Array.isArray(availableRoomNames) && availableRoomNames.length > 0) {
    const normalizedAvailable = availableRoomNames.map(n => n.toLowerCase().replace(/suite\s*/i, '').trim());
    candidates = candidates.filter(room => {
      const roomNorm = room.name.toLowerCase().trim();
      return normalizedAvailable.some(avail => avail.includes(roomNorm) || roomNorm.includes(avail));
    });
  }

  // Filtra por capacidade mínima necessária
  if (totalGuests && totalGuests > 0) {
    candidates = candidates.filter(room => room.capacity >= totalGuests);
  }

  // Ordena por capacidade ascendente (best fit = menor capacidade que atende)
  candidates.sort((a, b) => a.capacity - b.capacity);

  return candidates;
}

const SYSTEM_PROMPT = `Você é especialista em reservas do Casarão do Luar. Seu papel é conduzir a conversa com cordialidade e profissionalismo, coletar os dados da estadia de forma natural, consultar a disponibilidade REAL no sistema e encaminhar para confirmação humana apenas quando tudo estiver validado.

## REGRAS DE TOM E ESTILO (OBRIGATÓRIO)
- EMOJIS: Use NO MÁXIMO 1 emoji por mensagem, e apenas em momentos de saudação, celebração de disponibilidade ou despedida. Nas mensagens intermediárias de coleta de dados (perguntas sobre datas, hóspedes, confirmações), NÃO use emojis. O tom deve ser elegante e humano, não infantil.
- Comece SEMPRE com uma saudação calorosa e acolhedora, falando em nome do Casarão do Luar. NUNCA use nome próprio (nada de "Sou o Alfredo" ou similar) e NUNCA se apresente como "especialista".
- Na PRIMEIRA mensagem da conversa, quando o cliente ainda NÃO tiver apresentado uma solicitação, use obrigatoriamente esta estrutura (pode adaptar levemente o texto, mas mantenha os elementos e o emoji): "Olá! Seja muito bem-vindo ao Casarão do Luar 🏡 Estou aqui para ajudar você a encontrar a estadia perfeita. Como posso ajudar você hoje?" Se o cliente já tiver informado datas, grupo, preço, disponibilidade ou qualquer outro pedido, cumprimente, reconheça o pedido e não repita "Como posso ajudar você hoje?".
- REGRA DE OURO: Faça SOMENTE UMA pergunta por mensagem. Nunca acumule múltiplas perguntas ou solicitações na mesma resposta. Aguarde a resposta do cliente antes de prosseguir para a próxima etapa.
- Priorize o pedido atual do hóspede. Pergunta sobre região/pousada e curiosidades são opcionais; nunca interrompa pedido sobre preço, disponibilidade ou reserva para seguir um roteiro.
- Tom conversacional, empático e natural — como se fosse um especialista real conversando pelo WhatsApp. Use expressões humanas como "Que bom!", "Entendo perfeitamente", "Fico feliz em saber", "Combinado!". Evite robô, fórmulas repetitivas ou linguagem corporativa fria.
- TRANSIÇÕES NATURAIS: nunca pule direto de um assunto para outro. Use conectivos suaves: "Perfeito! Agora me diz...", "Combinado! Só mais uma coisinha...", "Então vamos lá:". Isso torna a conversa fluida e humana.
- CONFIRMAÇÃO EMPÁTICA: quando o cliente der uma informação, valide antes de prosseguir. Ex: "3 adultos, anotado!", "Janeiro é uma ótima escolha.". Nunca apenas repita o dado mecanicamente.
- RITMO E BLOCOS: Responda em blocos coesos de texto (2-4 frases curtas por parágrafo), evitando mensagens fragmentadas ou excessivamente longas. Mantenha um ritmo natural de conversa humana: não responda instantaneamente como um robô; uma pausa sutil entre as interações transmite atenção e cuidado. Agrupe informações relacionadas em um único bloco antes de fazer a próxima pergunta.
- CURIOSIDADES E CONEXÃO: são opcionais e usadas apenas quando relevantes ao pedido do cliente. No máximo uma por mensagem, sem repetição, e nunca interrompa coleta de datas/hóspedes, disponibilidade, preço ou reserva para contá-las. Use apenas fatos da seção CONHECIMENTO SOBRE CABO FRIO.
- Não use prova social, escassez ou características de quartos como argumento comercial, a menos que o sistema tenha fornecido esse dado de forma verificável.

## SOBRE O CASARÃO DO LUAR (DIFERENCIAIS)
Sempre que oportuno (especialmente após a pergunta sobre a região ou quando o cliente demonstrar interesse), mencione nossos diferenciais de forma natural e breve:
- Estamos a apenas 500 metros da Praia do Forte, a praia mais famosa e referência na região.
- Ficamos ao lado do maior polo gastronômico de Cabo Frio — restaurantes, bares e cafés a poucos passos.
- Dá para fazer tudo andando: praia, jantar, passeios e compras sem precisar de carro ou Uber.
- Bairro da Passagem: charmoso, tranquilo e com fácil acesso ao Centro e ao Canal Itajuru.
Não despeje todos os diferenciais de uma vez. Use 1-2 pontos relevantes por mensagem, de forma conversacional.

## DADOS JÁ DISPONÍVEIS (NÃO PERGUNTE NOVAMENTE)
- O nome do cliente já vem no contexto como [Nome do cliente: XXX]. USE esse nome para personalizar a conversa, mas NUNCA pergunte "qual seu nome?" se já tiver essa informação.
- O telefone/WhatsApp do cliente já é conhecido pelo sistema (vem do próprio WhatsApp). NUNCA peça "me informe seu telefone" ou "seu WhatsApp" — esse dado já está disponível automaticamente.
- Se o cliente disser "sou o João" mas o contexto mostrar outro nome, confirme gentilmente: "Vi aqui que seu cadastro está como [nome do contexto], está correto?"

## FLUXO DE CONVERSA (FLEXÍVEL, PRIORIZANDO O PEDIDO DO HÓSPEDE)
1. **Boas-vindas:** Saudação inicial obrigatória (veja REGRAS DE TOM). Esta é a ÚNICA mensagem onde você faz a pergunta "Como posso ajudar?".
2. **Região/Pousada (OPCIONAL):** Pergunte sobre a região apenas quando for relevante ao interesse do hóspede por passeios, praias, pontos turísticos ou localização. Se o cliente estiver pedindo preço, disponibilidade, datas ou reserva, siga diretamente o fluxo comercial sem perguntar sobre a região.
   - Se SIM → valorize brevemente e prossiga.
   - Se NÃO → use no máximo uma curiosidade se ela ajudar a responder ao assunto; caso contrário, siga para o pedido atual.
   - O pin só é enviado após mensagem textual com endereço se o cliente não conhece a região, pede a localização ou aceita explicitamente uma oferta para enviá-la. Nunca envie de novo depois de registrado.
3. **Dados da estadia:** siga a COLETA ESTRUTURADA e pergunte somente o próximo dado que falta. Se não houver data definida, ajude a escolher um período perguntando mês/época preferida ou flexibilidade, sem inventar disponibilidade ou preço.
4. **Disponibilidade:** consulte somente quando os dados obrigatórios estiverem completos.
5. **Confirmação e encaminhamento:** siga as regras comerciais existentes.

## COLETA ESTRUTURADA (apenas o que FALTA)
Antes de consultar disponibilidade, você PRECISA ter TODOS estes dados confirmados. Pule os que já tem:
1. ~~Nome completo~~ → já disponível no contexto
2. ~~Telefone/WhatsApp~~ → já disponível automaticamente
3. Número de adultos e número de crianças (separados)
4. **Idade de CADA criança** (obrigatório — temos valores especiais por faixa etária). Se o cliente disse "2 criancas" mas nao informou as idades, pergunte: "Qual a idade de cada crianca? Temos condicoes especiais dependendo da faixa etaria."
5. Data de check-in
6. Data de check-out

## PERGUNTAS INTELIGENTES
- NUNCA repita perguntas já respondidas — nem as do contexto (nome, telefone) nem as que o cliente já respondeu na conversa.
- Se o cliente disse "dia 25", pergunte apenas "Até que dia?" — não peça entrada E saída de novo.
- Se ainda não definiu datas, ajude a descobrir perguntando qual mês/época prefere ou se tem flexibilidade. Sugira comparar períodos sem afirmar disponibilidade, preços ou eventos não consultados; só consulte quando houver datas concretas.
- Se a mensagem do cliente estiver incompleta ou cortada ("gostaria de saber mais sobre"), peça para completar ANTES de prosseguir. Exemplo: "Pode me contar um pouco mais? Assim te ajudo melhor."
- Colete os dados na ordem acima, mas aproveite qualquer informação que o cliente já tenha dado espontaneamente.
- Faça UMA pergunta por vez. Nunca liste múltiplas perguntas numa mesma mensagem.
- Após a pergunta sobre a região, comece a coleta com: "Para começar, quantas pessoas vão se hospedar? (adultos e crianças)"
- Se o cliente informar crianças SEM idades, a PRÓXIMA pergunta obrigatória é sobre as idades, antes de prosseguir para datas.
- ⚠️ REGRA ANTI-REPETIÇÃO (CRÍTICA): Se o cliente disse "apenas adultos", "todos adultos", "não tem criança", "somente adultos" ou similar, É PROIBIDO perguntar sobre crianças ou suas idades. Pule essa etapa IMEDIATAMENTE e siga para a próxima (datas ou confirmação). Perguntar sobre crianças após o cliente afirmar que são só adultos é erro grave e inaceitável.

## CONSULTA DE DISPONIBILIDADE — REGRA CRÍTICA
- Você SÓ pode afirmar disponibilidade após chamar a função checkAvailability(checkIn, checkOut, guests) e receber resposta positiva.
- JAMAIS invente, suponha ou alucine disponibilidade.
- PROIBIDO responder com frases como "Vou consultar e retorno", "Um momento, por favor" ou "Vou verificar com a equipe" sem EXECUTAR IMEDIATAMENTE a função checkAvailability. Se você tem todos os dados (datas + hóspedes), CHAME a função AGORA e responda com o resultado real.
- Se faltar algum dado obrigatório (datas ou hóspedes), peça o dado faltante. Só prometa consultar quando TODOS os dados estiverem completos.
- Se o cliente perguntar "verificou?", "e aí?", "conseguiu ver?" ou similar E você já tiver todos os dados no histórico, EXECUTE a consulta imediatamente — nunca repita promessa de consulta.
- Se não houver disponibilidade no período exato, ofereça datas próximas alternativas ANTES de negar definitivamente. Só encerre após esgotar as opções.
- ⚠️ NÃO REPITA CONSULTA: Se você JÁ consultou a disponibilidade e JÁ apresentou o resultado ao cliente (com quartos disponíveis ou lotado), NUNCA consulte novamente nem repita a mensagem de disponibilidade. Após apresentar o resultado, siga para coleta de dados (se faltam) ou para confirmação/encaminhamento (se já tem tudo). Mensagens como "ok", "sim", "pode encaminhar" APÓS a consulta são confirmações de prosseguimento, NÃO novos pedidos de disponibilidade.

## CONFIRMAÇÃO ANTES DE ENCAMINHAR
Quando todos os dados estiverem coletados E a disponibilidade for confirmada E o cliente escolher uma suíte, você DEVE resumir tudo e informar que está encaminhando para um especialista. Após essa mensagem, PARE DE RESPONDER — o atendente humano assume a conversa.
"Perfeito! Confirmando seus dados:
• Nome: [nome]
• Telefone: [telefone]
• Pessoas: [nº]
• Check-in: [data]
• Check-out: [data]
• Suíte: [suíte escolhida]

Tudo certo! Já estou encaminhando para nosso especialista confirmar sua reserva. Um momento! ✨"

⚠️ Após enviar essa mensagem de encaminhamento, NÃO responda mais a nenhuma mensagem deste contato. O handoff é automático e imediato.

## REGRAS GERAIS
- Sempre responda em português do Brasil.
- Tom amigável mas profissional. Breve, sem enrolação.
- Se receber áudio, peça gentilmente para reenviar por texto.
- PRECO: o sistema calcula e envia a cotação com os valores da tabela. Você NUNCA faz conta, nunca estima valor e nunca promete desconto. Se o cliente pedir valor antes de datas e hóspedes, colete esses dados primeiro.
- Após consultar a disponibilidade, RECOMENDE as suítes adequadas ao perfil do cliente com nome, capacidade e link direto para escolha. NUNCA liste suítes (nem links, nem catálogo) antes de saber QUANTAS PESSOAS vão se hospedar: se o cliente informar apenas as datas, pergunte primeiro o número de adultos e crianças.
- Quando o hóspede demonstrar intenção explícita de reservar/confirmar/fechar, não responda mais — um especialista humano assumirá.

## USO DO NOME DO CLIENTE
- Quando souber o nome do cliente (fornecido via pushName), use-o naturalmente na saudação e ao longo da conversa. Exemplo: "Olá, Arthur! Como posso ajudar?"
- Se o pushName não estiver disponível ou for genérico, use saudação neutra.
- Se o cliente informar o nome completo durante a coleta estruturada, priorize esse nome sobre o pushName nas respostas seguintes.

## MEMÓRIA E CONTEXTO — REGRA CRÍTICA
- Cada conversa é independente. NUNCA cite, assuma ou reuse dados (idades, número de pessoas, datas, preferências) de conversas anteriores ou de outros clientes.
- Se o histórico atual não contém uma informação, trate como desconhecida e pergunte ao cliente — nunca invente ou recupere de sessões passadas.
- Ao confirmar dados, cite APENAS o que o cliente disse NESTA conversa. Se algo parecer repetido ou confuso, confirme com o cliente em vez de assumir.`;

/**
 * Carrega o system prompt do arquivo externo (editável via painel admin).
 * Se o arquivo não existir ou estiver vazio, usa o DEFAULT_SYSTEM_PROMPT.
 * Leitura síncrona intencional: chamada uma vez por requisição, custo desprezível.
 */
function loadSystemPrompt() {
  try {
    if (fs.existsSync(SYSTEM_PROMPT_FILE)) {
      const content = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf-8').trim();
      if (content.length > 0) return content;
    }
  } catch (err) {
    logWarn(`Falha ao ler ${SYSTEM_PROMPT_FILE}: ${err.message}. Usando prompt padrão.`);
  }
  return SYSTEM_PROMPT;
}

const FALLBACK_MESSAGE = 'Opa, tô com um probleminha técnico aqui 😅 Pode me mandar de novo daqui a pouquinho?';

// Falha real ou resposta inventada: o humano assume e o cliente recebe um aviso leve.
const HANDOFF_FAILURE_MESSAGE = 'Ops! Nosso sistema de reservas resolveu tirar um cochilo bem na hora H 😴 Já chamei uma pessoa da equipe para assumir daqui — ela confirma suas datas, suítes e valores sem inventar nada. Só um instante! 💛';

// Delay humano: simula tempo de digitação para parecer conversa natural.
// Lido do arquivo de configuração a cada uso para o painel admin valer em tempo real.
function humanDelay() {
  const { humanDelayMs } = getSettings();
  if (!humanDelayMs) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, humanDelayMs));
}

const MONTH_MAP = {
  janeiro: '01', fevereiro: '02', março: '03', marco: '03', abril: '04',
  maio: '05', junho: '06', julho: '07', agosto: '08', setembro: '09',
  outubro: '10', novembro: '11', dezembro: '12',
  jan: '01', fev: '02', mar: '03', abr: '04', jun: '06',
  jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12',
};

async function callLLM(messages) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    logError('[orchestrator] LLM_API_KEY not configured');
    return null;
  }

  try {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      { model, messages, max_tokens: 500, temperature: 0.7 },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return response.data.choices?.[0]?.message?.content || null;
  } catch (error) {
    const detail = error.response ? `HTTP ${error.response.status}` : error.message;
    logError(`[orchestrator] LLM call failed: ${detail}`);
    return null;
  }
}

function detectHandoff(text) {
  return HANDOFF_PATTERNS.some((p) => p.test(text));
}

function detectAvailabilityRequest(text) {
  return AVAILABILITY_PATTERN.test(text);
}

function detectAudio(text) {
  return AUDIO_PATTERN.test(text);
}

function extractDates(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const currentYear = new Date().getFullYear();

  // Pattern 1: "de DD a DD de MES [de YYYY]"
  const ptRange = normalized.match(/de\s+(\d{1,2})\s+a\s+(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (ptRange) {
    const dayIn = ptRange[1].padStart(2, '0');
    const dayOut = ptRange[2].padStart(2, '0');
    const month = MONTH_MAP[ptRange[3]];
    const year = ptRange[4] || String(currentYear);
    if (month) return { checkIn: `${year}-${month}-${dayIn}`, checkOut: `${year}-${month}-${dayOut}` };
  }

  // Pattern 2: "DD/MM[/YYYY] a/ate/- DD/MM[/YYYY]"
  const slashRange = normalized.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:a|ate|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (slashRange) {
    const dayIn = slashRange[1].padStart(2, '0');
    const monthIn = slashRange[2].padStart(2, '0');
    const yearIn = slashRange[3] || String(currentYear);
    const dayOut = slashRange[4].padStart(2, '0');
    const monthOut = slashRange[5].padStart(2, '0');
    const yearOut = slashRange[6] || yearIn;
    return { checkIn: `${yearIn}-${monthIn}-${dayIn}`, checkOut: `${yearOut}-${monthOut}-${dayOut}` };
  }

  // Pattern 3: ISO dates
  const isoRange = normalized.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (isoRange) return { checkIn: isoRange[1], checkOut: isoRange[2] };

  // Pattern 4: check-in/check-out labels with ISO or slash dates
  const ciMatch = normalized.match(/check[-\s]?in\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
  const coMatch = normalized.match(/check[-\s]?out\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
  if (ciMatch && coMatch) {
    const parseDate = (raw) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const parts = raw.split('/');
      return `${parts[2] || String(currentYear)}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    };
    return { checkIn: parseDate(ciMatch[1]), checkOut: parseDate(coMatch[1]) };
  }

  // Pattern 5a: "dia DD ate dia DD de MES_A para MES_B" (mês só no final, ex: "dia 30 até o dia 4 de dezembro para janeiro")
  const ptCrossMonth = normalized.match(/(?:dia\s+)?(\d{1,2})\s+(?:ate|a|-|para)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})\s+de\s+([a-z]+)\s+(?:para|a|ate)\s+([a-z]+)(?:\s+de\s+(\d{4}))?/);
  if (ptCrossMonth) {
    const dayIn = ptCrossMonth[1].padStart(2, '0');
    const dayOut = ptCrossMonth[2].padStart(2, '0');
    const monthIn = MONTH_MAP[ptCrossMonth[3]];
    const monthOut = MONTH_MAP[ptCrossMonth[4]];
    const year = ptCrossMonth[5] || String(currentYear);
    if (monthIn && monthOut) {
      let yearOut = year;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !ptCrossMonth[5]) {
        yearOut = String(parseInt(year, 10) + 1);
      }
      return { checkIn: `${year}-${monthIn}-${dayIn}`, checkOut: `${yearOut}-${monthOut}-${dayOut}` };
    }
  }

  // Pattern 5b: "dia DD ate dia DD de MES" ou "DD de MES ate DD [de] MES"
  // Nota: após normalização NFD + remoção de diacríticos, "até" vira "ate" e "–" vira ""
  // O mês após o primeiro dia só é capturado se seguido de espaço+de ou fim (evita confundir "ate" com mês)
  const ptRangeCheckin = normalized.match(/(?:check[-\s]?in\s*|dia\s+)?(\d{1,2})\s+(?:de\s+)?(?:([a-z]+)\s+)?(?:de\s+(\d{4})\s+)?(?:ate|a|-|para)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})(?:\s+de\s+)?([a-z]+)?(?:\s+de\s+(\d{4}))?/);
  if (ptRangeCheckin) {
    const dayIn = ptRangeCheckin[1].padStart(2, '0');
    const dayOut = ptRangeCheckin[4].padStart(2, '0');
    // Se só há um mês na frase (ex: "dia 20 até dia 24 de janeiro"), ele vale para ambas as datas
    const rawMonthIn = ptRangeCheckin[2];
    const rawMonthOut = ptRangeCheckin[5];
    const singleMonth = (!rawMonthIn && rawMonthOut) ? rawMonthOut : rawMonthIn;
    const monthIn = MONTH_MAP[rawMonthIn] || MONTH_MAP[singleMonth];
    const monthOut = MONTH_MAP[rawMonthOut] || monthIn;
    const yearIn = ptRangeCheckin[3] || ptRangeCheckin[6] || String(currentYear);
    const yearOut = ptRangeCheckin[6] || yearIn;
    if (monthIn && monthOut) {
      // Se checkout é mês seguinte e não foi especificado ano, assume próximo ano se necessário
      let finalYearOut = yearOut;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !ptRangeCheckin[6] && !ptRangeCheckin[3]) {
        finalYearOut = String(parseInt(yearIn, 10) + 1);
      }
      return { checkIn: `${yearIn}-${monthIn}-${dayIn}`, checkOut: `${finalYearOut}-${monthOut}-${dayOut}` };
    }
  }

  // Pattern 5c: intervalo de dias SEM mês na própria frase ("virada de ano dia 31 ate dia 03").
  // O mês/ano vem de outro ponto da conversa ("seria para dezembro"). Sem isso a IA volta a
  // perguntar as datas que o cliente já disse — o erro relatado no atendimento.
  const monthMentionRegex = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/g;
  const daysRangeRegex = /(?<![\d/])(\d{1,2})(?![\d/])\s*(?:ate|a)\s*(?:o\s+)?(?:dia\s+)?(\d{1,2})(?![\d/])/g;
  let daysRange;
  while ((daysRange = daysRangeRegex.exec(normalized)) !== null) {
    const dayIn = daysRange[1].padStart(2, '0');
    const dayOut = daysRange[2].padStart(2, '0');
    // Prioriza o mês citado ANTES do intervalo; depois aceita um mês posterior na mesma frase.
    let monthNum = null;
    let monthMatch;
    while ((monthMatch = monthMentionRegex.exec(normalized)) !== null) {
      if (monthMatch.index < daysRange.index) monthNum = MONTH_MAP[monthMatch[1]] || monthNum;
      else break;
    }
    monthMentionRegex.lastIndex = 0;
    if (!monthNum) {
      const anyMonth = normalized.slice(daysRange.index).match(monthMentionRegex);
      if (anyMonth) monthNum = MONTH_MAP[anyMonth[0]];
    }
    monthMentionRegex.lastIndex = 0;
    if (monthNum) {
      const range = buildRangeFromDaysAndMonth(dayIn, dayOut, monthNum);
      if (range) return range;
    }
  }

  return null;
}

function buildRangeFromDaysAndMonth(dayIn, dayOut, monthNum) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = new Date().getFullYear();
  const inDay = parseInt(dayIn, 10);
  const outDay = parseInt(dayOut, 10);
  let outMonth = parseInt(monthNum, 10);
  let outYear = year;
  if (outDay <= inDay) {
    outMonth += 1;
    if (outMonth > 12) { outMonth = 1; outYear += 1; }
  }
  return { checkIn: `${year}-${pad(monthNum)}-${pad(inDay)}`, checkOut: `${outYear}-${pad(outMonth)}-${pad(outDay)}` };
}

function validateDates(checkIn, checkOut) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let inDate = new Date(checkIn + 'T00:00:00');
  let outDate = new Date(checkOut + 'T00:00:00');

  if (isNaN(inDate.getTime()) || isNaN(outDate.getTime())) {
    return { valid: false, reason: 'Não consegui entender as datas. Pode confirmar no formato DD/MM/AAAA?' };
  }

  // Se a data de entrada estiver no passado, assume que o cliente se refere ao próximo ano
  // Isso evita rejeitar "20 de janeiro" quando já estamos em outubro/dezembro
  if (inDate < today) {
    const nextYear = inDate.getFullYear() + 1;
    inDate.setFullYear(nextYear);
    outDate.setFullYear(nextYear);
    logInfo('[orchestrator] Dates adjusted to next year (was in past)', { originalCheckIn: checkIn, newCheckIn: inDate.toISOString().split('T')[0] });
  }

  if (outDate <= inDate) {
    return { valid: false, reason: 'A data de saída precisa ser depois da entrada. Pode ajustar?' };
  }
  return { valid: true, checkIn: inDate.toISOString().split('T')[0], checkOut: outDate.toISOString().split('T')[0] };
}

// Cliente pedindo valor: só responde com cotação real, nunca com estimativa.
const QUOTE_INTENT_PATTERN = /quanto\s+(?:custa|ficaria|fica|sai|sairia|seria|é|e\b)|qual\s+(?:o\s+|seria\s+o\s+)?(?:valor|pre[cç]o)|pre[cç]o|di[aá]ria|or[cç]amento|valores|quanto\s+por\s+noite/i;

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectQuoteRequest(text) {
  return QUOTE_INTENT_PATTERN.test(text);
}

// Cliente aceita qualquer suíte (sem citar nome): a cotação usa o melhor encaixe.
const ANY_ROOM_PATTERN = /qualquer\s+(?:uma|su[ií]te|op[cç][aã]o)|tanto\s+faz|a\s+que\s+(?:couber|servir)|pode\s+ser\s+(?:qualquer|a\s+melhor|essa\s+mesma)|escolhe\s+(?:voc[eê]|por\s+mim)/i;

/** Suíte citada pelo cliente ("pode ser a Peró", "quero a Forte"). */
function selectedRoomFromText(text) {
  const normalized = normalizeForMatch(text);
  return ROOM_CATALOG.find((room) => normalized.includes(normalizeForMatch(room.name))) || null;
}

/** Última contagem de adultos/crianças dita pelo CLIENTE (ignora o catálogo enviado pela IA). */
function guestsFromHistory(history) {
  const userText = history.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  let adults = 0;
  let children = 0;
  const lastAdult = [...userText.matchAll(/(\d+)\s*adultos?/gi)].pop();
  const lastDois = [...userText.matchAll(/(?:dois|2)\s+adultos?/gi)].pop();
  if (lastAdult && lastAdult[1]) adults = parseInt(lastAdult[1], 10);
  else if (lastDois) adults = 2;
  if (adults === 0) {
    // "somos 4 pessoas": evita "até 4 pessoas", que é capacidade de suíte
    const peopleMatch = [...userText.matchAll(/(?<!at[ée]\s)(\d+)\s*pessoas?/gi)].pop();
    if (peopleMatch && peopleMatch[1]) adults = parseInt(peopleMatch[1], 10);
  }
  const lastChild = [...userText.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)].pop();
  if (lastChild && lastChild[1]) children = parseInt(lastChild[1], 10);
  return { adults, children, ages: extractChildrenAges(userText) };
}

/**
 * Valor por hóspede adicional e total são calculados em utils/pricing — aqui só
 * se monta o texto que o cliente recebe.
 */
function buildQuoteReply({ history, checkIn, checkOut, room }) {
  const { adults, children, ages } = guestsFromHistory(history);
  // Sem saber o grupo não há cotação confiável: quem informa é o especialista.
  if (adults === 0 && children === 0) return null;
  // Criança sem idade não pode sair de graça: sem a idade de todas, não cotamos.
  if (children > ages.length) {
    logWarn('[orchestrator] Quote blocked: missing child ages', { children, knownAges: ages.length });
    return null;
  }
  const childrenAges = ages.slice(0, children > 0 ? children : ages.length);
  const quote = calculateQuote(checkIn, checkOut, adults, childrenAges, { capacity: room ? room.capacity : null });
  if (!quote.ok) {
    logWarn('[orchestrator] Quote not available, deferring to specialist', { reason: quote.reason, missingDate: quote.missingDate });
    return null;
  }
  const body = formatQuote(quote, {
    roomName: room ? room.name : null,
    roomCapacity: room ? room.capacity : null,
    checkIn,
    checkOut,
    adults,
    childrenAges,
  });
  const amenities = '\n\n🛏️ *Todos os quartos incluem:*\n❄️ Ar-condicionado\n📺 Televisão\n🥂 Frigobar\n\n🏊 A pousada também oferece piscina e área de churrasqueira para aproveitar ao máximo sua estadia!\n\n📩 Garanta já sua reserva!!';
  return {
    content: `${body}${amenities}\n\nO que você achou da proposta?`,
    total: quote.total,
    roomsTotal: quote.roomsTotal,
    extrasPerNight: quote.extrasPerNight,
    nights: quote.nights,
  };
}

/**
 * Resumo de confirmação antes do handoff. Reaproveitado tanto na confirmação
 * curta ("sim") quanto no caminho de datas, para não repetir a lista de suítes
 * depois que o cliente já viu a cotação.
 * Devolve null quando ainda faltam datas.
 */
function buildHandoffSummary({ phoneNumber, pushName, history, checkIn, checkOut }) {
  const summaryText = history.map((m) => m.content).join(' ');
  const nameFromRegex = summaryText.match(/nome:\s*(.+)/i);
  const resolvedName = (pushName && pushName.trim()) || (nameFromRegex ? nameFromRegex[1].trim() : '');
  const nameLine = resolvedName ? `Nome: ${resolvedName}\n` : '';
  const phoneLine = `Telefone: ${phoneNumber}\n`;
  const { adults: sumAdults, children: sumChildren } = guestsFromHistory(history);
  const ages = extractChildrenAges(history.filter((m) => m.role === 'user').map((m) => m.content).join(' '));
  const agesLabel = ages.length > 0 ? ` (${ages.join(' e ')} anos)` : '';
  const guestsLine = (sumAdults > 0 || sumChildren > 0)
    ? `Pessoas: ${sumAdults} adultos${sumChildren > 0 ? `, ${sumChildren} crianças${agesLabel}` : ''}\n`
    : '';
  const datesLine = `Check-in: ${checkIn}\nCheck-out: ${checkOut}\n`;

  let summaryRoom = selectedRoomFromText(summaryText);
  if (!summaryRoom) {
    const fits = recommendRooms((sumAdults + sumChildren) || 2, null);
    summaryRoom = fits.length > 0 ? fits[0] : null;
  }
  const summaryRoomLine = summaryRoom ? `Suíte: ${summaryRoom.name}\n` : '';

  let totalLine = '';
  const quote = buildQuoteReply({ history, checkIn, checkOut, room: summaryRoom });
  if (quote) totalLine = `Valor total: ${formatBRL(quote.total)} (${quote.nights} noites)\n`;

  return `Perfeito! Vamos confirmar seus dados antes de encaminhar para nosso especialista:\n${nameLine}${phoneLine}${guestsLine}${datesLine}${summaryRoomLine}${totalLine}Está tudo correto? Posso encaminhar para nosso especialista confirmar sua reserva?`;
}

function formatAvailabilityReply(result, checkIn, checkOut, totalGuests) {
  if (result.error) {
    return null;
  }
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

  if (result.available === true) {
    // Recomenda suítes do catálogo baseadas no perfil (best fit)
    const availableRoomNames = result.availableRooms && Array.isArray(result.availableRooms) ? result.availableRooms : null;
    const recommended = recommendRooms(totalGuests, availableRoomNames);
    // Quantidade de quartos exibida deve refletir APENAS as suítes compatíveis com o grupo,
    // não o total bruto da API (que inclui suítes pequenas demais para o grupo)
    const compatibleCount = recommended.length;
    let roomInfo = 'Temos disponibilidade para essas datas!';
    if (compatibleCount > 0) {
      const label = compatibleCount === 1 ? 'opção de suíte' : 'opções de suítes';
      roomInfo = `Temos *${compatibleCount} ${label}* que comportam seu grupo para esse período`;
    } else if (result.roomCount && result.roomCount > 0) {
      // Fallback: se nenhuma suíte do catálogo atende mas há disponibilidade na API
      roomInfo = `Temos disponibilidade, mas preciso verificar uma suíte adequada para ${totalGuests || 'seu'} grupo`;
    }
    let reply = `Que ótima notícia! ${roomInfo}`;
    if (recommended.length > 0) {
      reply += '\n\n🏡 *Recomendações para você:*';
      recommended.forEach((r) => {
        reply += `\n• *${r.name}* (até ${r.capacity} pessoas): ${r.link}`;
      });
      reply += '\n\nQual dessas opções combina mais com você? Pode escolher pelo link ou me dizer o nome da suíte que prefere!';
    } else {
      // Separador consistente para permitir divisão multi_reply mesmo sem recomendações
      reply += '\n\nGostaria que eu verificasse alguma suíte específica ou prefere que eu recomende as melhores opções para seu grupo?';
    }
    return reply;
  }
  if (result.available === false) {
    return `Poxa, nesse período (${fmtDate(checkIn)} a ${fmtDate(checkOut)}) estamos com lotação máxima 😔\n\nMas não desanime! Posso verificar outras datas próximas para você. Qual seria sua segunda opção? 🗓️`;
  }
  return 'Ops, tive um probleminha para consultar a disponibilidade agora 😅 Mas não se preocupe! Um colega nosso pode verificar rapidinho. Pode me dizer suas datas preferidas?';
}

const POUSADA_ADDRESS_LINE = 'Praça Bandeira, 10 - Passagem, Cabo Frio - RJ';

// Todo retorno de disponibilidade cita a pousada/localização e leva o pin uma única vez por conversa.
function withAvailabilityLocation(history, reply, forcePin = false) {
  const alreadySent = history.some(m => m.role === 'assistant' && m.content === '[LOCATION_SENT]');
  if (alreadySent) return { content: reply, sendLocationAfterReply: false };
  // Pin só dispara se forçado (cotação/pergunta explícita) ou se a resposta já trouxer contexto de localização.
  const shouldSendPin = forcePin || LOCATION_CONTEXT_PATTERN.test(reply);
  if (!shouldSendPin) return { content: reply, sendLocationAfterReply: false };
  // Endereço entra no PRIMEIRO bloco: o pin sai logo depois dele.
  const blocks = reply.split(/\n\n/);
  blocks[0] = `${blocks[0]}\n\n📍 ${POUSADA_ADDRESS_LINE}`;
  return { content: blocks.join('\n\n'), sendLocationAfterReply: true };
}

// Falha real do sistema: nada de inventar suíte/valor — o humano assume.
async function handoffAfterFailure(phoneNumber, reason) {
  logWarn('[orchestrator] Availability check failed, handing off to human', { phoneNumber, reason });
  appendMessage(phoneNumber, 'assistant', HANDOFF_FAILURE_MESSAGE);
  await humanDelay();
  triggerHandoff(phoneNumber, reason);
  return { type: 'reply', content: HANDOFF_FAILURE_MESSAGE };
}

async function processMessage(phoneNumber, incomingText, pushName) {
  // Corrige encoding UTF-8 corrompido (comum em webhooks Windows/VPS)
  let cleanText = incomingText;
  try {
    // Tenta decodificar se vier como buffer ou string corrompida
    if (Buffer.isBuffer(incomingText)) {
      cleanText = incomingText.toString('utf-8');
    } else if (typeof incomingText === 'string') {
      // Remove caracteres de substituição U+FFFD e tenta normalizar
      cleanText = incomingText.replace(/\uFFFD/g, '').normalize('NFC');
    }
  } catch (e) {
    logWarn('[orchestrator] Encoding fix failed, using raw text', { error: e.message });
  }

  logInfo('[orchestrator] processMessage called', { phoneNumber, text: cleanText.substring(0, 100), pushName });

  if (shouldSilence(phoneNumber)) {
    logInfo('[orchestrator] Number is silenced', { phoneNumber });
    return { type: 'silence' };
  }

  // Registra a mensagem do usuário ANTES de qualquer verificação de estado para garantir que o histórico esteja atualizado
  appendMessage(phoneNumber, 'user', cleanText);

  // PEDIDO EXPLÍCITO DE ATENDIMENTO HUMANO: responde e passa o contato para o humano.
  // A partir daqui shouldSilence() devolve true e a IA não responde mais até ser reativada no painel.
  if (REQUEST_HUMAN_PATTERN.test(cleanText)) {
    logInfo('[orchestrator] Client requested a human agent', { phoneNumber });
    const reply = 'Claro! Já estou chamando nosso especialista para falar com você. Um momento, por favor.';
    appendMessage(phoneNumber, 'assistant', reply);
    await humanDelay();
    triggerHandoff(phoneNumber, 'cliente_pediu_humano');
    return { type: 'reply', content: reply };
  }

  // Contexto da conversa para respostas opcionais sobre localização/região.
  const historyForRegion = getHistory(phoneNumber);
  const firstAssistantIdx = historyForRegion.findIndex(h => h.role === 'assistant');
  const askedAboutRegion = historyForRegion.some((m, idx) => m.role === 'assistant' && idx !== firstAssistantIdx && /regi[aã]o|casar[aã]o do luar|bairro da passagem|j[aá] esteve|conhece\s+(?:a\s+)?(?:regi[aã]o|pousada|casar[aã]o|bairro|local)|ainda n[aã]o/i.test(m.content));
  // LOCALIZAÇÃO: o pin só pode sair DEPOIS da mensagem textual com diferenciais/endereço.
  // O orquestrador apenas sinaliza; o servidor envia o pin após entregar o texto.
  const locationAlreadySent = historyForRegion.some(m => m.role === 'assistant' && m.content === '[LOCATION_SENT]');
  const regionQuestionIdx = historyForRegion.findIndex((m, idx) => m.role === 'assistant' && idx !== firstAssistantIdx && /regi[aã]o|j[aá] esteve|conhece\s+(?:a\s+)?(?:regi[aã]o|pousada|casar[aã]o|bairro|local)|ainda n[aã]o/i.test(m.content));
  const userMessagesAfterRegionQuestion = regionQuestionIdx < 0 ? [] : historyForRegion
    .slice(regionQuestionIdx + 1)
    .filter(m => m.role === 'user')
    .map(m => normalizeForMatch(m.content));
  const userSaidNotKnowsRegion = userMessagesAfterRegionQuestion.some(text =>
    /(?:^|\b)(?:ainda\s+)?nao\b|nao\s+(?:conheco|conhece|sei|fui|conhecia)|nunca\s+(?:fui|estive|vim)|primeira\s+vez/.test(text)
  );
  const explicitlyRequestedLocation = /(?:manda|envia|me\s+envie|pode\s+mandar|quero)\s+(?:o\s+|a\s+)?(?:pin|localiza[cç][aã]o|endere[cç]o)|(?:onde\s+(?:fica|\s+\w+\s+fica)|me\s+passa\s+o\s+endere[cç]o)/i.test(cleanText);
  const offeredLocationAndAccepted = /^(?:sim|pode|claro|quero|manda|envia|por favor)(?:\b|[,!.])/i.test(normalizeForMatch(cleanText)) &&
    historyForRegion.some(m => m.role === 'assistant' && /(?:quer|posso|gostaria).{0,60}(?:pin|localiza[cç][aã]o|endere[cç]o)|(?:pin|localiza[cç][aã]o).{0,60}(?:posso enviar|quer que eu)/i.test(m.content));
  const canOfferLocation = !locationAlreadySent && (
    (askedAboutRegion && userSaidNotKnowsRegion) || explicitlyRequestedLocation || offeredLocationAndAccepted
  );

  // BLOQUEIO ANTI-REPETIÇÃO DE CRIANÇAS: Se o cliente já afirmou que são apenas adultos,
  // adiciona instrução de sistema para impedir que a LLM pergunte sobre crianças/idades novamente
  const historyTextLower = historyForRegion.map(m => m.content).join(' ').toLowerCase();
  const saidOnlyAdults = /apenas\s+adultos|somente\s+adultos|s[oó]\s+(?:tem\s+)?adultos?|todos\s+adultos|somos\s+(?:apenas\s+)?adultos|n[aã]o\s+tem\s+crian[cç]as?|sem\s+crian[cç]as?|n[aã]o\s+tenho\s+crian[cç]as?|0\s+crian[cç]as?|zero\s+crian[cç]as?|apenas\s+eu\s+e\s+(?:meu|minha)\s+(?:marido|esposa|companheiro|namorado)|eu\s+e\s+(?:meu|minha)\s+(?:marido|esposa|companheiro|namorado)/.test(historyTextLower);

  // PRIORIDADE: Se houver datas explícitas na mensagem OU no histórico, consulta disponibilidade ANTES de handoff
  let hasDates = extractDates(cleanText);
  const isConfirmation = CONFIRMATION_PATTERN.test(cleanText.trim());
  // Resolve datas curtas com o mês já citado nesta conversa antes de pedir qualquer esclarecimento.
  const shortRangeInput = cleanText.trim().match(/^(?:dia\s+)?(\d{1,2})\s+(?:a|ate|até|-|–)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})$/i);
  if (shortRangeInput && !extractDates(cleanText)) {
    const conversationText = historyForRegion.map(m => m.content).join(' ');
    const monthMatch = normalizeForMatch(conversationText).match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
    if (monthMatch) {
      hasDates = buildRangeFromDaysAndMonth(shortRangeInput[1], shortRangeInput[2], MONTH_MAP[monthMatch[1]]);
      logInfo('[orchestrator] Short date range resolved using month from conversation', { phoneNumber, checkIn: hasDates.checkIn, checkOut: hasDates.checkOut });
    } else {
      const reply = 'Perfeito! Para quais datas completas você está pensando?';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }
  }
  // Se a mensagem atual é apenas o nome de um mês (resposta a "qual mês?"), tenta recuperar datas do histórico
  const isMonthOnly = /^(?:de\s+|em\s+)?(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)$/i.test(cleanText.trim());
  // Se a mensagem atual é resposta de mês OU confirmação curta após pergunta de mês, força recuperação de datas
  // Isso cobre o caso onde o usuário responde "dezembro" após "qual mês?" e o sistema precisa consultar
  const isMonthResponseOrConfirmation = isMonthOnly || (isConfirmation && historyForRegion.some(m => m.role === 'assistant' && /qual m[eê]s|de qual m[eê]s/i.test(m.content)));
  // Resposta à pergunta "quantas pessoas vão se hospedar?": retoma a consulta de disponibilidade
  // com as datas já informadas, em vez de cair na LLM e perder o que foi coletado.
  const askedGuestCount = historyForRegion.some(m => m.role === 'assistant' && /quantas pessoas v[aã]o se hospedar/i.test(m.content));
  const mentionsGuests = /(\d+)\s*(?:adultos?|pessoas?|crian[cç]as?)/i.test(cleanText) || /\b(dois|duas|tres|tr[eê]s|quatro|cinco|seis|sete|oito)\s+(?:adultos?|pessoas?)/i.test(cleanText);
  const guestAnswerAfterQuestion = askedGuestCount && mentionsGuests;
  // "sim"/"não" isolado costuma estar respondendo à pergunta sobre a região, não pedindo
  // disponibilidade. Sem esta guarda a conversa desviava para "me diz as datas".
  const lastAssistantText = [...historyForRegion].reverse().find(m => m.role === 'assistant' && m.content !== '[LOCATION_SENT]');
  const answeredRegionQuestion = isConfirmation && lastAssistantText
    && /j[aá]\s+conhece|conhece\s+(?:a\s+)?(?:nossa\s+)?regi[aã]o|j[aá]\s+esteve|conhece\s+(?:a\s+)?pousada/i.test(lastAssistantText.content);
  if (offeredLocationAndAccepted && !locationAlreadySent) {
    const reply = 'Nosso endereço é Praça Bandeira, 10 - Passagem, Cabo Frio - RJ, 28906-320.';
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply, sendLocationAfterReply: true };
  }
  // Se a mensagem atual não tem datas mas é confirmação, pedido de disponibilidade OU resposta de mês,
  // busca datas no histórico completo para evitar pedir novamente ao cliente
  if (!hasDates && !answeredRegionQuestion && (isConfirmation || isMonthResponseOrConfirmation || (guestAnswerAfterQuestion && extractDates(historyForRegion.map(m => m.content).join(' '))))) {
    // Só recupera datas do histórico se NÃO for uma pergunta genérica de disponibilidade
    // "tem vaga?", "vocês tem vaga?" sem datas na mensagem atual NÃO deve usar datas de sessões anteriores
    const isGenericAvailabilityQuery = /(?:voc[eê]s?\s+)?(?:tem|têm|h[aá])\s+(?:vaga|quarto|disponib)/i.test(cleanText) && !extractDates(cleanText);
    if (!isGenericAvailabilityQuery) {
      const historyText = historyForRegion.map(m => m.content).join(' ');
      hasDates = extractDates(historyText);
      // Fallback: se extractDates não encontrou datas completas no histórico mas há padrão "DD a DD" ou "dia DD ate DD"
      // sem mês explícito, tenta recuperar o mês mencionado anteriormente no histórico
      if (!hasDates) {
        const shortRangeMatch = historyText.match(/(?:dia\s+)?(\d{1,2})\s+(?:ate|a|-|–)\s+(?:o\s+)?(?:dia\s+)?(\d{1,2})/i);
        if (shortRangeMatch) {
          const monthInHistory = historyText.match(/(?:de\s+|em\s+)(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i);
          if (monthInHistory) {
            const monthNum = MONTH_MAP[monthInHistory[1].toLowerCase()];
            if (monthNum) {
              hasDates = buildRangeFromDaysAndMonth(shortRangeMatch[1], shortRangeMatch[2], monthNum);
              logInfo('[orchestrator] Dates recovered from short range + month in history', { phoneNumber, checkIn: hasDates.checkIn, checkOut: hasDates.checkOut });
            }
          }
        }
      }
      if (hasDates) {
        logInfo('[orchestrator] Dates recovered from history', { phoneNumber, checkIn: hasDates.checkIn, checkOut: hasDates.checkOut });
      }
    } else {
      logInfo('[orchestrator] Generic availability query without dates, NOT using history dates', { phoneNumber });
    }
  }
  // PREÇO: só cota com disponibilidade confirmada e grupo/datas conhecidos.
  // O valor vem de calculateQuote (igual para qualquer leitura da tabela), nunca da LLM.
  const quoteIntent = detectQuoteRequest(cleanText);
  const selectedRoom = selectedRoomFromText(cleanText);
  const anyRoomAccepted = ANY_ROOM_PATTERN.test(cleanText);
  const availabilityShown = historyForRegion.some(m => m.role === 'assistant' && /quartos? dispon[ií]vel|op[cç][oõ]es de su[ií]tes|ótima not[ií]cia/i.test(m.content));

  if (quoteIntent || (availabilityShown && (selectedRoom || anyRoomAccepted))) {
    const historyText = historyForRegion.map(m => m.content).join(' ');
    let quoteDates = extractDates(cleanText) || extractDates(historyText);
    const quoteGuests = guestsFromHistory(historyForRegion);
    logInfo('[orchestrator] Quote intent detected', { phoneNumber, hasDates: !!quoteDates, adults: quoteGuests.adults, children: quoteGuests.children, room: selectedRoom && selectedRoom.name });

    const askDates = () => {
      const reply = 'Claro! Me diz as datas de entrada e saída que eu já te passo o valor da sua estadia.';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    };

    if (!quoteDates) return askDates();
    const quoteValidation = validateDates(quoteDates.checkIn, quoteDates.checkOut);
    if (!quoteValidation.valid) {
      appendMessage(phoneNumber, 'assistant', quoteValidation.reason);
      return { type: 'reply', content: quoteValidation.reason };
    }
    quoteDates = { checkIn: quoteValidation.checkIn, checkOut: quoteValidation.checkOut };

    if (quoteGuests.adults + quoteGuests.children === 0) {
      const reply = 'Claro! Para calcular o valor certinho, quantas pessoas vão se hospedar? (adultos e crianças)';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    const totalGuestsForQuote = quoteGuests.adults + quoteGuests.children;
    let roomForQuote = selectedRoom;
    if (!roomForQuote) {
      const bestFit = recommendRooms(totalGuestsForQuote, null);
      roomForQuote = bestFit.length > 0 ? bestFit[0] : null;
    }

    if (!availabilityShown) {
      const result = await checkAvailability(quoteDates.checkIn, quoteDates.checkOut, totalGuestsForQuote);
      logInfo('[orchestrator] Availability checked for quote', { phoneNumber, available: result && result.available });
      if (!result || result.available !== true) {
        const reply = formatAvailabilityReply(result || {}, quoteDates.checkIn, quoteDates.checkOut, totalGuestsForQuote);
        appendMessage(phoneNumber, 'assistant', reply);
        return { type: 'reply', content: reply };
      }
      const availableNames = result.availableRooms && result.availableRooms.length > 0 ? result.availableRooms : null;
      if (!roomForQuote) {
        const fitForQuote = recommendRooms(totalGuestsForQuote, availableNames);
        roomForQuote = fitForQuote.length > 0 ? fitForQuote[0] : null;
      }
    }

    const quote = buildQuoteReply({
      history: historyForRegion,
      checkIn: quoteDates.checkIn,
      checkOut: quoteDates.checkOut,
      room: roomForQuote,
    });

if (quote) {
      const located = withAvailabilityLocation(historyForRegion, quote.content, true);
      appendMessage(phoneNumber, 'assistant', located.content);
      await humanDelay();
      return { type: 'reply', content: located.content, sendLocationAfterReply: located.sendLocationAfterReply };
    }

    // Criança sem idade: perguntar é o caminho — o valor depende da faixa etária.
    if (quoteGuests.children > quoteGuests.ages.length) {
      const reply = 'Para eu calcular o valor certinho, qual a idade de cada criança? A faixa etária muda o valor do hóspede adicional.';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    // Grupo maior que a suíte citada: oferece a suíte que comporta, antes de cotar.
    if (roomForQuote && totalGuestsForQuote > roomForQuote.capacity) {
      const fits = recommendRooms(totalGuestsForQuote, null);
      const options = fits.slice(0, 3).map((r) => `*${r.name}* (até ${r.capacity} pessoas)`).join(', ');
      const reply = `A suíte ${roomForQuote.name} acomoda até ${roomForQuote.capacity} pessoas, e o grupo é de ${totalGuestsForQuote}. ${options ? `Para o seu grupo eu recomendo: ${options}. Qual você prefere?` : 'Me diz quantas pessoas são que eu vejo a melhor opção.'}`;
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    // Sem cotação segura (período fora da tabela): o especialista informa o valor.
    const fallback = 'Para esse período eu prefiro confirmar o valor com nosso especialista antes de te passar, para não te dar uma informação errada. Já estou verificando e ele te retorna com os valores.';
    appendMessage(phoneNumber, 'assistant', fallback);
    return { type: 'reply', content: fallback };
  }

  // Após a cotação, "sim"/"ok" é confirmação da proposta — não um novo pedido de consulta.
  // Sem isso o cliente que já viu o valor recebia a lista de suítes de novo.
  const quoteAlreadyShown = historyForRegion.some(
    (m) => m.role === 'assistant' && /Total \(\d+ noites\): R\$|O que você achou da proposta/i.test(m.content)
  );
  if (quoteAlreadyShown && isConfirmation && hasDates) {
    const summaryAskedYet = historyForRegion.some(
      (m) => m.role === 'assistant' && /posso\s+encaminhar/i.test(m.content)
    );
    if (summaryAskedYet) {
      logInfo('[orchestrator] Client confirmed forwarding after quote, triggering handoff', { phoneNumber });
      const reply = 'Perfeito! Já estou encaminhando para nosso especialista confirmar sua reserva. Um momento! ✨';
      appendMessage(phoneNumber, 'assistant', reply);
      await humanDelay();
      triggerHandoff(phoneNumber, 'confirmado_pelo_cliente');
      return { type: 'reply', content: reply };
    }
    logInfo('[orchestrator] Confirmation after quote, generating handoff summary', { phoneNumber });
    const summaryReply = buildHandoffSummary({
      phoneNumber,
      pushName,
      history: historyForRegion,
      checkIn: hasDates.checkIn,
      checkOut: hasDates.checkOut,
    });
    appendMessage(phoneNumber, 'assistant', summaryReply);
    return { type: 'reply', content: summaryReply };
  }

  // Cliente declarou que ainda não tem data: rota para a ajuda de período (empatia + recomendação),
  // em vez de perguntar "quais as datas?" de novo.
  const noDatesDeclared = /(?:n[aã]o|ainda\s+n[aã]o)\s+(?:sei|tenho|defini|decidi|escolhi).{0,25}(?:data|datas|per[ií]odo|m[eê]s|dia)|sem\s+(?:data|datas)\s+definida|datas?\s+flex[ií]ve|qualquer\s+(?:data|per[ií]odo|m[eê]s)|estou\s+flex[ií]vel/i.test(cleanText);
  // Confirmação respondendo à pergunta sobre a região não é intenção de disponibilidade:
  // sem isso o cliente que responde "sim" recebia "me diz as datas" antes de qualquer oferta.
  const isAvailabilityIntent = detectAvailabilityRequest(cleanText) || hasDates || (isConfirmation && !answeredRegionQuestion) || guestAnswerAfterQuestion || noDatesDeclared;
  if (isAvailabilityIntent) {
    logInfo('[orchestrator] Availability intent detected', { phoneNumber, hasDates: !!hasDates, isConfirmation });
    if (!hasDates) {
      // Verifica se já houve consulta anterior — confirmação curta não deve pedir datas de novo
      const alreadyChecked = historyForRegion.some(m => m.role === 'assistant' && /quartos? dispon[ií]vel|lot[aã]o m[aá]xima|ótima not[ií]cia/i.test(m.content));
      // Se já prometeu consultar e agora recebeu confirmação curta COM datas no histórico, executa consulta ANTES de gerar resumo
      const promisedCheck = historyForRegion.some(m => m.role === 'assistant' && /vou consultar|um momento|verificando|posso verificar/i.test(m.content));
      // Recupera hóspedes do histórico para permitir consulta automática em confirmações
      let confirmedAdults = 0;
      let confirmedChildren = 0;
      const cGuestText = historyForRegion.map(m => m.content).join(' ');
      const cAdultMatches = [...cGuestText.matchAll(/(\d+)\s*(?:adultos?|pessoas?)/gi)];
      const cDoisMatches = [...cGuestText.matchAll(/(?:dois|2)\s+adultos?/gi)];
      const lastCAdult = cAdultMatches.pop();
      const lastCDois = cDoisMatches.pop();
      if (lastCAdult && lastCAdult[1]) confirmedAdults = parseInt(lastCAdult[1], 10);
      else if (lastCDois) confirmedAdults = 2;
      const cChildMatches = [...cGuestText.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)];
      const lastCChild = cChildMatches.pop();
      if (lastCChild && lastCChild[1]) confirmedChildren = parseInt(lastCChild[1], 10);
      const hasGuestsInHistory = (confirmedAdults + confirmedChildren) > 0;
      // Dentro deste ramo hasDates é null: sem datas recuperáveis não há consulta nem resumo.
      const recoveredDates = extractDates(historyForRegion.map(m => m.content).join(' '));
      // Datas já citadas nesta conversa + grupo conhecido: segue direto para a consulta,
      // sem pedir a data de novo (o cliente não repete data nem mês).
      if (!alreadyChecked && recoveredDates && hasGuestsInHistory) {
        hasDates = recoveredDates;
        logInfo('[orchestrator] Dates and guests in history, skipping date question', { phoneNumber, checkIn: hasDates.checkIn, checkOut: hasDates.checkOut });
      }
      if (!hasDates && !alreadyChecked && promisedCheck && isConfirmation && recoveredDates && hasGuestsInHistory) {
        logInfo('[orchestrator] Confirmation after promise-to-check, forcing availability query', { phoneNumber });
        const finalCheckIn = recoveredDates.checkIn;
        const finalCheckOut = recoveredDates.checkOut;
        const guestTextForQuery = historyForRegion.map(m => m.content).join(' ');
        let qAdults = 0;
        let qChildren = 0;
        const qAdultMatches = [...guestTextForQuery.matchAll(/(\d+)\s*(?:adultos?|pessoas?)/gi)];
        const qDoisMatches = [...guestTextForQuery.matchAll(/(?:dois|2)\s+adultos?/gi)];
        const lastQAdult = qAdultMatches.pop();
        const lastQDois = qDoisMatches.pop();
        if (lastQAdult && lastQAdult[1]) qAdults = parseInt(lastQAdult[1], 10);
        else if (lastQDois) qAdults = 2;
        const qChildMatches = [...guestTextForQuery.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)];
        const lastQChild = qChildMatches.pop();
        if (lastQChild && lastQChild[1]) qChildren = parseInt(lastQChild[1], 10);
        const qTotal = (qAdults + qChildren) || undefined;
        const result = await checkAvailability(finalCheckIn, finalCheckOut, qTotal);
        if (!result || result.error || result.available == null) {
          return await handoffAfterFailure(phoneNumber, 'falha_consulta_disponibilidade');
        }
        if (result.available === true) {
          const located = withAvailabilityLocation(historyForRegion, formatAvailabilityReply(result, finalCheckIn, finalCheckOut, qTotal), false);
          appendMessage(phoneNumber, 'assistant', located.content);
          return { type: 'reply', content: located.content, sendLocationAfterReply: located.sendLocationAfterReply };
        } else {
          const reply = formatAvailabilityReply(result, finalCheckIn, finalCheckOut, qTotal);
          appendMessage(phoneNumber, 'assistant', reply);
          return { type: 'reply', content: reply };
        }
      }
      if (alreadyChecked && isConfirmation && recoveredDates) {
        // Se a IA já perguntou "posso encaminhar?" e o cliente confirmou, encaminha de verdade
        // em vez de repetir o mesmo resumo (laço que travava a conversa).
        const summaryAlreadyAsked = historyForRegion.some(m => m.role === 'assistant' && /posso\s+encaminhar/i.test(m.content));
        if (summaryAlreadyAsked) {
          logInfo('[orchestrator] Client confirmed forwarding, triggering handoff', { phoneNumber });
          const reply = 'Perfeito! Já estou encaminhando para nosso especialista confirmar sua reserva. Um momento! ✨';
          appendMessage(phoneNumber, 'assistant', reply);
          await humanDelay();
          triggerHandoff(phoneNumber, 'confirmado_pelo_cliente');
          return { type: 'reply', content: reply };
        }
        logInfo('[orchestrator] Confirmation after availability shown, generating summary for handoff', { phoneNumber });
        const summaryReply = buildHandoffSummary({
          phoneNumber,
          pushName,
          history: getHistory(phoneNumber),
          checkIn: recoveredDates.checkIn,
          checkOut: recoveredDates.checkOut,
        });
        appendMessage(phoneNumber, 'assistant', summaryReply);
        return { type: 'reply', content: summaryReply };
      } else if (!hasDates) {
        logInfo('[orchestrator] No dates found in message or history, asking user', { phoneNumber });
        const historyText = historyForRegion.map(m => m.content).join(' ');
        const hasNoDates = !extractDates(historyText);
        // Se o cliente já mencionou um mês (ex: "dezembro"), NÃO usar modo consultivo nem falar de temporadas.
        // Pedir os dias diretamente — isso evita a resposta errada quando o cliente diz "tem vaga para dezembro?".
        const mentionedMonth = /\b(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i.test(cleanText + ' ' + historyText);
        const askDatesReply = 'Claro, posso verificar a disponibilidade. Me diz as datas de entrada e saída que já consulto para você.';
        let reply;
        if (mentionedMonth || !hasNoDates) {
          reply = askDatesReply;
        } else {
          const dateHelpAlreadyOffered = historyForRegion.some(m => m.role === 'assistant' && /encontrar um per[ií]odo|datas s[aã]o flex[ií]veis|qual m[eê]s ou [eé]poca/i.test(m.content));
          if (!dateHelpAlreadyOffered) {
            reply = 'Sem problema! Para eu te ajudar melhor, você já tem um mês ou período em mente, ou suas datas são flexíveis?';
          } else if (askedGuestCount && !mentionsGuests) {
            reply = 'Combinado! Para eu te mostrar as suítes que cabem no seu grupo, quantas pessoas vão se hospedar? (adultos e crianças)';
          } else {
            reply = askDatesReply;
          }
        }
        appendMessage(phoneNumber, 'assistant', reply);
        return { type: 'reply', content: reply };
      }
    }

    logInfo('[orchestrator] Dates extracted', { phoneNumber, checkIn: hasDates.checkIn, checkOut: hasDates.checkOut });
    const validation = validateDates(hasDates.checkIn, hasDates.checkOut);
    if (!validation.valid) {
      logInfo('[orchestrator] Date validation failed', { phoneNumber, reason: validation.reason });
      appendMessage(phoneNumber, 'assistant', validation.reason);
      return { type: 'reply', content: validation.reason };
    }

    // Usa datas corrigidas (com ano ajustado) se a validação retornou novas datas
    const finalCheckIn = validation.checkIn || hasDates.checkIn;
    const finalCheckOut = validation.checkOut || hasDates.checkOut;

    // Extrai total de hóspedes do histórico para passar à consulta
    const historyForGuests = getHistory(phoneNumber);
    const guestText = historyForGuests.map(m => m.content).join(' ');
    // Parser consolidado de hóspedes: busca apenas a ÚLTIMA menção válida de cada tipo para evitar duplicação por eco/repetição
    let adults = 0;
    let children = 0;
    const allAdultMatches = [...guestText.matchAll(/(\d+)\s*(?:adultos?|pessoas?)/gi)];
    const allDoisMatches = [...guestText.matchAll(/(?:dois|2)\s+adultos?/gi)];
    const lastAdultMatch = allAdultMatches.pop();
    const lastDoisMatch = allDoisMatches.pop();
    if (lastAdultMatch && lastAdultMatch[1]) adults = parseInt(lastAdultMatch[1], 10);
    else if (lastDoisMatch) adults = 2;
    const allChildMatches = [...guestText.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)];
    const lastChildMatch = allChildMatches.pop();
    if (lastChildMatch && lastChildMatch[1]) children = parseInt(lastChildMatch[1], 10);
    // Validação cruzada: se houver total explícito mais recente que seja maior, usa ele como piso
    const allTotalMatches = [...guestText.matchAll(/(\d+)\s*pessoas?/gi)];
    const lastTotalMatch = allTotalMatches.pop();
    const explicitTotal = lastTotalMatch ? parseInt(lastTotalMatch[1], 10) : 0;
    const computedTotal = adults + children;
    const totalGuests = (explicitTotal > computedTotal ? explicitTotal : computedTotal) || undefined;

    // Sem número de hóspedes não há como indicar a melhor suíte: pede a quantidade ANTES de listar
    // (o catálogo exibido precisa ser filtrado pela capacidade do grupo).
    if (!totalGuests) {
      logInfo('[orchestrator] Guests unknown, asking guest count before listing rooms', { phoneNumber });
      const fmt = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}`; };
      const reply = `Perfeito, anotei ${fmt(finalCheckIn)} a ${fmt(finalCheckOut)}! Para eu te mostrar as suítes que realmente cabem no seu grupo, quantas pessoas vão se hospedar? (adultos e crianças)`;
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    // REQUISITO 1.2: número de pessoas sem dizer "adultos"/"crianças" não garante que o grupo
    // é só de adultos — confirma a composição antes de listar suítes.
    const userGroupText = historyForRegion.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const saidPeopleWithoutComposition = /(\d+|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito)\s*pessoas?/i.test(userGroupText)
      && !/(?:adultos?|crian[cç]as?|kids?)/i.test(userGroupText);
    const childrenAlreadyConfirmed = /(?:n[aã]o|sem)\s+(?:tem\s+|tenho\s+|h[aá]\s+)?crian[cç]as?|(?:apenas|somente|s[oó])\s+adultos|todos\s+adultos/i.test(userGroupText);
    const childCompositionAsked = historyForRegion.some(m => m.role === 'assistant' && /todas\s+adultos|alguma\s+crian|adultos\s+ou\s+(?:com\s+)?crian/i.test(m.content));
    if (saidPeopleWithoutComposition && !childrenAlreadyConfirmed && !childCompositionAsked) {
      logInfo('[orchestrator] Guest count without composition, confirming children', { phoneNumber });
      const reply = `Combinado, ${totalGuests} pessoas. Só me confirma: o grupo é todo de adultos ou tem criança junto?`;
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    // REQUISITO 1.3: criança sem idade não permite calcular o hóspede adicional.
    const knownAges = extractChildrenAges(userGroupText);
    const agesAlreadyAsked = historyForRegion.some(m => m.role === 'assistant' && /idade\s+de\s+cada\s+crian/i.test(m.content));
    if (children > 0 && knownAges.length < children && !agesAlreadyAsked) {
      logInfo('[orchestrator] Children without ages, asking before listing rooms', { phoneNumber, children, knownAges: knownAges.length });
      const reply = 'Perfeito, anotei as crianças! Qual a idade de cada uma? Temos condições especiais por faixa etária, então isso muda o valor do hóspede adicional.';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }

    logInfo(`[orchestrator] Checking availability for ${phoneNumber.replace(/(\d{2})\d+(\d{4})/, '$1*****$2')}: ${finalCheckIn} → ${finalCheckOut}, guests=${totalGuests || 'N/A'}`);
    const result = await checkAvailability(finalCheckIn, finalCheckOut, totalGuests);

    logInfo('[orchestrator] Availability check returned', { phoneNumber, available: result && result.available, roomCount: result && result.roomCount, error: result && result.error });
    if (!result || result.error || result.available == null) {
      // FALHA REAL: nenhuma suíte/valor inventado — o atendimento humano assume o contato.
      return await handoffAfterFailure(phoneNumber, 'falha_consulta_disponibilidade');
    }
    const located = withAvailabilityLocation(historyForRegion, formatAvailabilityReply(result, finalCheckIn, finalCheckOut, totalGuests), true);
    const reply = located.content;
    const sendLocationAfterReply = located.sendLocationAfterReply;

    // Divide a resposta em duas mensagens para humanizar: confirmação + recomendações
    const splitPoint = reply.indexOf('\n\n🏡');
    if (splitPoint > 0 && result.available === true) {
      const msg1 = reply.substring(0, splitPoint).trim();
      const msg2 = reply.substring(splitPoint).trim();
      appendMessage(phoneNumber, 'assistant', msg1);
      await humanDelay();
      appendMessage(phoneNumber, 'assistant', msg2);
      return { type: 'multi_reply', contents: [msg1, msg2], sendLocationAfterReply };
    }

    appendMessage(phoneNumber, 'assistant', reply);
    // NÃO dispara handoff automaticamente após disponibilidade.
    // O handoff só ocorre quando o cliente confirma explicitamente ou escolhe a suíte.
    return { type: 'reply', content: reply, sendLocationAfterReply };
  }

  // Handoff só se NÃO houver datas extraíveis E a conversa já tiver avançado
  // Se a mensagem contém datas + hóspedes (mesmo com "quero reservar"), consulta disponibilidade PRIMEIRO
  // Isso garante que a IA responda com resultado real em vez de transferir sem consultar
  const datesInMessage = extractDates(cleanText);
  
  if (detectHandoff(cleanText) && !datesInMessage) {
    // Handoff sem datas extraídas: pede as datas antes de transferir ou seguir para LLM
    logInfo('[orchestrator] Handoff pattern without dates, asking for dates first', { phoneNumber });
    const reply = 'Claro, posso verificar a disponibilidade. Me diz as datas de entrada e saida que ja consulto para voce.';
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply };
  }
  
  if (detectAudio(incomingText)) {
    logInfo('[orchestrator] Audio message detected', { phoneNumber });
    const reply = 'Ola! Nao consigo ouvir audios ainda. Pode me mandar por texto? Assim te respondo rapidamente.';
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply };
  }

  // Default: use LLM
  logInfo('[orchestrator] Falling through to LLM path', { phoneNumber });
  const history = getHistory(phoneNumber);
  const nameContext = pushName ? `[Nome do cliente: ${pushName}]` : '[Nome do cliente: desconhecido]';
  const phoneContext = `[Telefone/WhatsApp do cliente: ${phoneNumber}] — este dado já está disponível automaticamente, NUNCA pergunte.`;
  const messages = [
    { role: 'system', content: loadSystemPrompt() },
    { role: 'system', content: nameContext },
    { role: 'system', content: phoneContext },
    ...(saidOnlyAdults ? [{ role: 'system', content: '[REGRA OBRIGATÓRIA] O cliente já informou que são APENAS ADULTOS. NUNCA pergunte sobre crianças, idades de crianças ou quantidade de crianças. Pule essa etapa completamente e siga para o próximo passo do fluxo.' }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  logInfo('[orchestrator] Calling LLM API', { phoneNumber, messageCount: messages.length });
  const llmReply = await callLLM(messages);
  logInfo('[orchestrator] LLM API returned', { phoneNumber, responseLength: llmReply?.length ?? 0, isFallback: !llmReply });
  const reply = llmReply || FALLBACK_MESSAGE;

  // REQUISITO 1.3: a LLM às vezes responde "vou consultar" sem que a consulta aconteça — e aí
  // o cliente fica sem retorno para sempre. Com datas e hóspedes completos, executa a consulta
  // aqui e entrega o resultado real no lugar da promessa.
  const PROMISE_PATTERN = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  // Se a disponibilidade já foi entregue nesta conversa, repetir a consulta só duplicaria a lista de suítes.
  const availabilityAlreadyDelivered = historyForRegion.some(m => m.role === 'assistant' && /comportam seu grupo|op[cç][oõ]es de su[ií]tes|quartos? dispon[ií]vel/i.test(m.content));
  if (llmReply && !availabilityAlreadyDelivered && !HANDOFF_SENT_PATTERN.test(reply) && PROMISE_PATTERN.test(reply)) {
    const promisedDates = extractDates(cleanText) || extractDates(historyForRegion.map(m => m.content).join(' '));
    const groupHistory = historyForRegion.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const groupAdults = [...groupHistory.matchAll(/(\d+)\s*(?:adultos?|pessoas?)/gi)].pop();
    const groupChildren = [...groupHistory.matchAll(/(\d+)\s*crian[cç]as?/gi)].pop();
    const promisedGuests = (groupAdults ? parseInt(groupAdults[1], 10) : 0) + (groupChildren ? parseInt(groupChildren[1], 10) : 0);
    const promisedChildren = groupChildren ? parseInt(groupChildren[1], 10) : 0;
    const promisedAges = extractChildrenAges(groupHistory);
    if (promisedDates && promisedGuests > 0 && promisedChildren <= promisedAges.length) {
      const promisedValidation = validateDates(promisedDates.checkIn, promisedDates.checkOut);
      if (promisedValidation.valid) {
        logInfo('[orchestrator] LLM promised a check, executing availability now', { phoneNumber, guests: promisedGuests });
        const promisedResult = await checkAvailability(promisedValidation.checkIn, promisedValidation.checkOut, promisedGuests);
        if (!promisedResult || promisedResult.error || promisedResult.available == null) {
          return await handoffAfterFailure(phoneNumber, 'falha_consulta_disponibilidade');
        }
        const promisedLocated = withAvailabilityLocation(historyForRegion, formatAvailabilityReply(promisedResult, promisedValidation.checkIn, promisedValidation.checkOut, promisedGuests), false);
        appendMessage(phoneNumber, 'assistant', promisedLocated.content);
        return { type: 'reply', content: promisedLocated.content, sendLocationAfterReply: promisedLocated.sendLocationAfterReply };
      }
    }
  }

  // ENCAMINHAMENTO: quando a resposta passa a conversa para o especialista, ou quando a IA
  // falha tecnicamente, o atendimento humano assume e a IA para de responder este contato.
  if (!llmReply) {
    triggerHandoff(phoneNumber, 'ia_sem_resposta');
  } else if (!/\?\s*$/.test(reply.trim()) && HANDOFF_SENT_PATTERN.test(reply)) {
    triggerHandoff(phoneNumber, 'encaminhado_especialista');
  }

  // O pin só é autorizado quando a resposta atual (ou uma anterior) já trouxe o texto
  // de contexto/endereço; o servidor o envia depois de entregar essa mensagem.
  const locationContextInHistory = historyForRegion.some(m => m.role === 'assistant' && LOCATION_CONTEXT_PATTERN.test(m.content));
  // Divide a resposta em blocos: o cliente pediu blocos separados (contexto primeiro, pergunta depois).
  // O pin vai após o PRIMEIRO bloco quando ele traz o contexto/endereço.
  const blocks = reply.split(/\n?-{3,}\n?/).map(b => b.trim()).filter(Boolean);
  const replyBlocks = blocks.length > 1 ? blocks : null;


  // Se o primeiro bloco já traz contexto de endereço, o pin vai depois dele.
  // Endereço inline: só se o usuário pediu explicitamente E a resposta não tem contexto
  // E o pin NÃO vai ser enviado (evita duplicar o que já vem no pin).
  const sendLocationAfterReply = canOfferLocation && firstBlockHasContext;

  const userExplicitlyRequested = historyForRegion.length > 0 &&
    historyForRegion[historyForRegion.length - 1].role === 'user' &&
    LOCATION_REQUEST_PATTERN.test(historyForRegion[historyForRegion.length - 1].content);
  const shouldAppendLocationContext =
    userExplicitlyRequested &&
    !LOCATION_CONTEXT_PATTERN.test(reply);

  const locationReply = shouldAppendLocationContext
    ? `${reply}\n\nNosso endereço é Praça Bandeira, 10 - Passagem, Cabo Frio - RJ, 28906-320.`
    : reply;

  !sendLocationAfterReply;  // pinInline já cobre o contexto → não duplicar

  // Aplica delay humano antes de retornar resposta da LLM
  await humanDelay();
  logInfo('[orchestrator] processMessage returning', { phoneNumber, resultType: finalReplyBlocks ? 'multi_reply' : 'reply', content: locationReply.substring(0, 100) });
  if (finalReplyBlocks) {
    finalReplyBlocks.forEach(b => appendMessage(phoneNumber, 'assistant', b));
    return { type: 'multi_reply', contents: finalReplyBlocks, sendLocationAfterReply };
  }
  appendMessage(phoneNumber, 'assistant', locationReply);
  return { type: 'reply', content: locationReply, sendLocationAfterReply };
}

module.exports = { processMessage };