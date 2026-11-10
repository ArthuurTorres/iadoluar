const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHistory, appendMessage, getState, updateState, persistResult, markQuotePresented, markHandoffConfirmed, isQuoteValidFor, appendMessageWithState, extractGuestsFromText } = require('./utils/context');
const { shouldSilence, triggerHandoff } = require('./utils/handoff');
const { getSettings } = require('./utils/settings');
const { calculateQuote, formatQuote, extractChildrenAges, formatBRL, formatDateBR } = require('./utils/pricing');
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
const REQUEST_HUMAN_PATTERN = /(?:falar|conversar)\s+com\s+(?:um\s+|uma\s+)?(?:humano|atendente|pessoa|algu[eé]m|respons[aá]vel)|atendimento\s+humano|quero\s+(?:um\s+)?atendente|(?:me\s+)?passa[r]?\s+(?:para|pra)\s+(?:um[a]?\s+)?(?:humano|atendente|pessoa)|chama[r]?\s+(?:um\s+)?(?:humano|atendente)/i;

// Resposta da IA que encerra o atendimento passando a conversa para o especialista
const HANDOFF_SENT_PATTERN = /(?:estou|vou)\s+encaminhando|encaminhando\s+(?:agora|sua reserva|seu atendimento|para)|transferindo\s+(?:voc[eê]|sua conversa)|(?:especialista|atendente|equipe)\s+(?:vai|ir[aá])\s+(?:te\s+)?(?:confirmar|entrar em contato)/i;

const AVAILABILITY_PATTERN = /disponib|\btem\s+vaga|\bvagas?\b|quarto\s+livre|datas\s+de\s+entrada|check[-\s]?in/i;
// Confirmações curtas válidas para prosseguir em fluxos de coleta/disponibilidade.
// NÃO inclui "ok", "perfeito", "entendi", "obrigado", "certo" — esses são apenas
// confirmações de leitura após cotação e não devem disparar handoff nem consulta automática.
const CONFIRMATION_PATTERN = /^(?:sim|isso|correto|confirmo|pode|claro|ta|tá|exato|certinho|confirmado)$/i;

// Intenção EXPLÍCITA de reserva: só estas frases disparam handoff pós-cotação.
// Exclui genéricos ("sim", "ok") e hipotéticos/negativos ("não quero reservar ainda").
const EXPLICIT_RESERVE_PATTERN = /(?:quero|desejo|pretendo)\s+(?:reservar|fechar|confirmar\s+(?:a\s+)?reserva|garantir\s+(?:a\s+)?(?:reserva|hospedagem|vaga|quarto))|(?:pode|vou)\s+(?:fechar|confirmar|reservar|garantir)(?:\s+(?:a\s+)?(?:reserva|hospedagem|para\s+mim|comigo))?|confirmo\s+a\s+reserva|fecho\s+(?:a\s+)?(?:reserva|hospedagem)|quero\s+(?:o\s+)?(?:quarto|su[ií]te)|garanto\s+(?:a\s+)?(?:reserva|hospedagem)/i;

// Negação ou hipótese de reserva: se casar, NÃO é intenção de fechar mesmo que EXPLICIT_RESERVE_PATTERN case.
const RESERVE_NEGATION_PATTERN = /n[aã]o\s+(?:quero|desejo|posso|pretendo|preciso)\s+(?:reservar|fechar|confirmar|garantir)|(?:ainda\s+)?n[aã]o\s+(?:quero|desejo|posso|pretendo)\s+(?:reservar|fechar|confirmar|garantir)|ser[aá]\s+que\s+(?:posso|d[aá])\s+(?:reservar|fechar)|quero\s+saber\s+(?:como\s+)?(?:reservar|fechar)|gostaria\s+de\s+saber\s+(?:como\s+)?(?:reservar|fechar)|(?:como\s+)?fa[cç]o\s+(?:para\s+)?(?:reservar|fechar)|sem\s+compromisso|s[oó]\s+(?:estou\s+)?(?:vendo|pesquisando|olhando|curiosando)/i;

// Aprovação da cotação: cliente gostou do que viu e quer seguir.
// Não confirma reserva (isso é EXPLICIT_RESERVE_PATTERN), mas encerra a repetição
// do orçamento e leva ao resumo de confirmação.
const QUOTE_APPROVAL_PATTERN = /^(?:gostei|amei|adorei|ficou\s+(?:bom|ótimo|otimo|perfeito)|achei\s+(?:bom|ótimo|otimo|perfeito)|(?:está|esta|tá|ta)\s+(?:bom|ótimo|otimo|perfeito)|perfeito|ótimo|otimo|excelente|maravilha|pode\s+ser|por\s+mim\s+(?:ok|tudo\s+bem)|com\s+certeza|quero\s+(?:sim|esse|essa)|vamos\s+(?:nessa|fechar|em\s+frente)|bora)\b/i;

const AUDIO_PATTERN = /(?:^|\s)(?:audio|áudio|voz)\s*$/i;

// Texto que precede o pin: endereço ou diferenciais da pousada/região
const LOCATION_CONTEXT_PATTERN = /pra[cç]a bandeira|rua dos tri[aâ]ngulos|endereço|500 metros|praia do forte|polo gastron|bairro da passagem|[aá]guas cristalinas|p[oô]r do sol|canal itajuru|gastron[oô]mico|curiosidade|sabia que|imperd[ií]vel|vale a pena|encantador|charme|vibe|clima acolhedor|para[í]so|lugar especial/i;
const LOCATION_REQUEST_PATTERN = /(?:manda|envia|me\s+envie|pode\s+mandar|quero)\s+(?:o\s+|a\s+)?(?:pin|localiza[cç][aã]o|endere[cç]o)|(?:onde\s+(?:fica|\s+\w+\s+fica)|me\s+passa\s+o\s+endere[cç]o)/i;

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

  if (!apiKey) {
    logError('[orchestrator] LLM_API_KEY not configured');
    return null;
  }

  // Lê configuração dinâmica do disco (permite alteração hot sem reinício)
  const { getLlmConfig, getApiStyle } = require('./utils/llmConfig');
  let config;
  try {
    config = getLlmConfig();
  } catch (err) {
    logError(`[orchestrator] Failed to read LLM config: ${err.message}`);
    config = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.7, maxTokens: 500 };
  }

  const { baseUrl, model, temperature, maxTokens } = config;

  try {
    if (getApiStyle(config.provider) === 'anthropic') {
      // A API da Anthropic tem outro formato: /messages, x-api-key e system separado
      const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const chatMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
      const body = { model, messages: chatMessages, max_tokens: maxTokens, temperature };
      if (systemParts) body.system = systemParts;
      const response = await axios.post(`${baseUrl}/messages`, body, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000,
      });
      return response.data.content?.[0]?.text || null;
    }

    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      { model, messages, max_tokens: maxTokens, temperature },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return response.data.choices?.[0]?.message?.content || null;
  } catch (error) {
    const detail = error.response ? `HTTP ${error.response.status}` : error.message;
    logError(`[orchestrator] LLM call failed (${model}@${baseUrl}): ${detail}`);
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

  // Pattern 1b: datas rotuladas por palavra — "entrada 05 de janeiro saída 10 de janeiro",
  // "check-in 05/01 check-out 10/01". O cliente escreve assim no atendimento real.
  const labeledMonth = normalized.match(/(?:entrada|check[-\s]?in)\s*:?\s*(?:dia\s+)?(\d{1,2})\s*(?:de|\/)\s*([a-z]+|\d{1,2})(?:\s*(?:de|\/)\s*(\d{4}))?[^a-z0-9]*(?:e\s+)?(?:saida|check[-\s]?out)\s*:?\s*(?:dia\s+)?(\d{1,2})\s*(?:de|\/)\s*([a-z]+|\d{1,2})(?:\s*(?:de|\/)\s*(\d{4}))?/);
  if (labeledMonth) {
    const monthIn = MONTH_MAP[labeledMonth[2]] || (/^\d{1,2}$/.test(labeledMonth[2]) ? labeledMonth[2].padStart(2, '0') : null);
    const monthOut = MONTH_MAP[labeledMonth[5]] || (/^\d{1,2}$/.test(labeledMonth[5]) ? labeledMonth[5].padStart(2, '0') : null);
    if (monthIn && monthOut) {
      const yearIn = labeledMonth[3] || String(currentYear);
      let yearOut = labeledMonth[6] || yearIn;
      if (parseInt(monthOut, 10) < parseInt(monthIn, 10) && !labeledMonth[6]) {
        yearOut = String(parseInt(yearIn, 10) + 1);
      }
      return {
        checkIn: `${yearIn}-${monthIn}-${labeledMonth[1].padStart(2, '0')}`,
        checkOut: `${yearOut}-${monthOut}-${labeledMonth[4].padStart(2, '0')}`,
      };
    }
  }

  // Pattern 2: "DD/MM[/YYYY] a/ate/- DD/MM[/YYYY]"
  // "ao" e o "dia" opcional cobrem "dia 05/01 ao dia 10/01" sem quebrar "05/01 a 10/01".
  const slashRange = normalized.match(/(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:ate|ao|a|-|–)\s*(?:o\s+)?(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
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
const QUOTE_INTENT_PATTERN = /quanto\s+(?:custa|ficaria|fica|sai|sairia|seria|é|e\b|vou\s+pagar|vou\s+gastar)|(?:vou\s+pagar|vou\s+gastar)\s+quanto|qual\s+(?:o\s+|seria\s+o\s+)?(?:valor|pre[cç]o|total)|(?:e|sobre)\s+(?:o\s+)?(?:valor|pre[cç]o)|pre[cç]o|di[aá]ria|or[cç]amento|valores|total\s+(?:de|da|do)\b|quanto\s+por\s+noite/i;

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

/** Suíte do catálogo pelo nome exato persistido no estado. */
function roomByName(name) {
  if (!name) return null;
  const normalized = normalizeForMatch(name);
  return ROOM_CATALOG.find((room) => normalizeForMatch(room.name) === normalized) || null;
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
function buildQuoteReply({ history, checkIn, checkOut, room, state }) {
  // Usa estado estruturado como fonte primária; fallback para regex quando estado não tem dados de hóspedes
  const s = state || {};
  let adults = s.adults != null ? s.adults : null;
  let children = s.children != null ? s.children : null;
  let ages = s.childrenAges || [];
  // Fallback: se estado não tem adultos nem crianças, tenta extrair do histórico textual
  if (adults == null && children == null && history) {
    const fallback = guestsFromHistory(history);
    adults = fallback.adults;
    children = fallback.children;
    ages = fallback.ages || [];
  }
  adults = adults || 0;
  children = children || 0;
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
  const amenities = '\n\n🛏️ *Todos os quartos incluem:*\n❄️ Ar-condicionado\n📺 Televisão\n🥂 Frigobar\n\n🏊 A pousada também oferece piscina e área de churrasqueira para aproveitar ao máximo sua estadia!';
  return {
    ok: true,
    content: `${body}${amenities}\n\nO que você achou da proposta?`,
    total: quote.total,
    roomsTotal: quote.roomsTotal,
    extrasPerNight: quote.extrasPerNight,
    nights: quote.nights,
  };
}

/**
 * Valor formatado do orçamento já persistido (fonte: pricing.js, nunca a LLM).
 * Devolve null quando não há orçamento válido para os dados atuais.
 */
function persistedQuoteFor(phoneNumber, overrides = {}) {
  const entry = isQuoteValidFor(phoneNumber, overrides);
  if (!entry || !entry.result || entry.result.total == null) return null;
  return entry;
}

/**
 * Resumo de confirmação antes do handoff. Usa a suíte persistida no estado e o
 * orçamento que o cliente já recebeu — nunca escolhe suíte por conta própria nem
 * recota com dados diferentes dos que geraram a proposta apresentada.
 * Devolve null quando não há orçamento válido ou faltam datas.
 */
function buildHandoffSummary({ phoneNumber, pushName, history, checkIn, checkOut }) {
  const summaryText = history.map((m) => m.content).join(' ');
  const nameFromRegex = summaryText.match(/nome:\s*(.+)/i);
  const resolvedName = (pushName && pushName.trim()) || (nameFromRegex ? nameFromRegex[1].trim() : '');
  const nameLine = resolvedName ? `👤 Nome: ${resolvedName}\n` : '';
  const phoneLine = `📱 Telefone: ${phoneNumber}\n`;
  // Usa estado estruturado como fonte primária para handoff
  const handoffState = getState(phoneNumber);
  const sumAdults = handoffState && handoffState.adults != null ? handoffState.adults : 0;
  const sumChildren = handoffState && handoffState.children != null ? handoffState.children : 0;
  const ages = (handoffState && handoffState.childrenAges) || [];
  const agesLabel = ages.length > 0 ? ` (${ages.join(' e ')} anos)` : '';
  const guestsLine = (sumAdults > 0 || sumChildren > 0)
    ? `👥 Pessoas: ${sumAdults} adultos${sumChildren > 0 ? `, ${sumChildren} crianças${agesLabel}` : ''}\n`
    : '';
  const datesLine = `📅 Check-in: ${formatDateBR(checkIn)}\n📅 Check-out: ${formatDateBR(checkOut)}\n`;

  // O valor e a suíte vêm do orçamento que o cliente recebeu, não de um recálculo.
  const presentedQuote = persistedQuoteFor(phoneNumber, { checkIn, checkOut });
  if (!presentedQuote) {
    logWarn('[orchestrator] Handoff summary blocked: no presented quote for current data', { phoneNumber, checkIn, checkOut, room: handoffState ? handoffState.selectedRoom : null });
    return null;
  }
  // A suíte do resumo é a que foi cotada: com recomendação automática o estado não
  // tem selectedRoom, e usar null aqui mostraria um resumo sem suíte.
  const quotedRoomName = (presentedQuote.params && presentedQuote.params.room) || (handoffState && handoffState.selectedRoom) || null;
  const summaryRoom = quotedRoomName ? roomByName(quotedRoomName) : null;
  const summaryRoomLine = quotedRoomName ? `🏡 Suíte: ${summaryRoom ? summaryRoom.name : quotedRoomName}\n` : '';
  const totalLine = `💰 Valor total: ${formatBRL(presentedQuote.result.total)} (${presentedQuote.result.nights} noites)\n`;

  return `✨ Perfeito! Vamos confirmar seus dados antes de encaminhar para nosso especialista:\n${nameLine}${phoneLine}${guestsLine}${datesLine}${summaryRoomLine}${totalLine}✅ Está tudo correto? Posso encaminhar para nosso especialista confirmar sua reserva? 🎉`;
}

function formatAvailabilityReply(result, checkIn, checkOut, totalGuests, selectedRoom = null) {
  if (result.error) {
    return null;
  }
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

  if (result.available === true) {
    // Recomenda suítes do catálogo baseadas no perfil (best fit)
    const availableRoomNames = result.availableRooms && Array.isArray(result.availableRooms) ? result.availableRooms : null;
    // Se o cliente já escolheu uma suíte, filtra apenas ela (se disponível) em vez de listar todas
    // C2: selectedRoom pode chegar como objeto do catálogo (novo) ou string (chamadas legadas).
    const selectedRoomName = selectedRoom && typeof selectedRoom === 'object' ? selectedRoom.name : selectedRoom;
    const recommended = selectedRoomName && availableRoomNames && availableRoomNames.some(n => n.toLowerCase() === selectedRoomName.toLowerCase())
      ? recommendRooms(totalGuests, [selectedRoomName])
      : recommendRooms(totalGuests, availableRoomNames);
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
  // O pin só sai para quem não conhece a região ou pede explicitamente: avaliado no texto
  // ORIGINAL, antes do endereço ser acrescentado (senão todo fluxo viraria pedido de pin).
  const shouldSendPin = !alreadySent && (forcePin || LOCATION_CONTEXT_PATTERN.test(reply));
  // O endereço é obrigatório em todo fluxo de disponibilidade/preço/reserva, inclusive para
  // quem já conhece a região (prompt v12) — nesse caso sem pin.
  if (reply.includes(POUSADA_ADDRESS_LINE)) return { content: reply, sendLocationAfterReply: shouldSendPin };
  const blocks = reply.split(/\n\n/);
  blocks[0] = `${blocks[0]}\n\n📍 ${POUSADA_ADDRESS_LINE}`;
  return { content: blocks.join('\n\n'), sendLocationAfterReply: shouldSendPin };
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

  // PEDIDO EXPLÍCITO DE ATENDIMENTO HUMANO: prioridade ABSOLUTA sobre qualquer fluxo.
  // Responde e passa o contato para o humano imediatamente, sem coletar dados antes.
  // A partir daqui shouldSilence() devolve true e a IA não responde mais até ser reativada no painel.
  if (REQUEST_HUMAN_PATTERN.test(cleanText)) {
    logInfo('[orchestrator] Client requested a human agent', { phoneNumber });
    const reply = 'Claro! Já estou chamando nosso especialista para falar com você. Um momento, por favor.';
    appendMessage(phoneNumber, 'assistant', reply);
    await humanDelay();
    triggerHandoff(phoneNumber, 'cliente_pediu_humano');
    return { type: 'reply', content: reply };
  }

  // PROTEÇÃO CONTRA HANDOFF DUPLICADO: se o contato continua em atendimento humano,
  // não dispara novamente. Usa shouldSilence (e não isHandoffTriggered) porque o
  // "Devolver para a IA" do painel mantém o registro de handoff no histórico: ali
  // o override está ativo e a IA precisa voltar a responder.
  if (shouldSilence(phoneNumber)) {
    logInfo('[orchestrator] Handoff already triggered for this contact, silencing', { phoneNumber });
    return { type: 'silence' };
  }

  // FASE 0 — Extração estruturada da mensagem atual + atualização do estado
  // Executa APÓS as guardas de silêncio/handoff para evitar persistir dados em conversas encerradas.
  // Merge parcial: só atualiza campos presentes na mensagem; campos omitidos preservam valores anteriores.
  const guestPartial = extractGuestsFromText(cleanText);
  const datePartial = extractDates(cleanText);
  const roomPartial = selectedRoomFromText(cleanText);
  const stateUpdate = {};
  if (guestPartial.adults !== undefined) stateUpdate.adults = guestPartial.adults;
  if (guestPartial.children !== undefined) stateUpdate.children = guestPartial.children;
  if (guestPartial.childrenAges !== undefined) stateUpdate.childrenAges = guestPartial.childrenAges;
  if (datePartial && datePartial.checkIn) stateUpdate.checkIn = datePartial.checkIn;
  if (datePartial && datePartial.checkOut) stateUpdate.checkOut = datePartial.checkOut;
  if (roomPartial) stateUpdate.selectedRoom = roomPartial.name;
  if (Object.keys(stateUpdate).length > 0) {
    try {
      updateState(phoneNumber, stateUpdate);
    } catch (e) {
      logWarn('[orchestrator] updateState failed in FASE 0', { phoneNumber, error: e.message });
    }
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
  // Recupera estado estruturado; se não existir, hidrata do histórico automaticamente
  const conversationState = getState(phoneNumber);
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
  // Se a mensagem atual é apenas o nome de um mês (resposta a "qual mês?" ou interesse espontâneo), trata como informação parcial
  const monthOnlyMatch = cleanText.trim().match(/^(?:de\s+|em\s+)?(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)$/i);
  const isMonthOnly = !!monthOnlyMatch;
  // Se a mensagem atual é resposta de mês OU confirmação curta após pergunta de mês, força recuperação de datas
  // Isso cobre o caso onde o usuário responde "dezembro" após "qual mês?" e o sistema precisa consultar
  const isMonthResponseOrConfirmation = isMonthOnly || (isConfirmation && historyForRegion.some(m => m.role === 'assistant' && /qual m[eê]s|de qual m[eê]s/i.test(m.content)));

  // MÊS ISOLADO: cliente informou apenas o mês sem dias. Pergunta quais dias deseja,
  // preservando o mês no contexto para completar depois. Só ativa em contexto de disponibilidade.
  if (isMonthOnly && !hasDates && detectAvailabilityRequest(historyForRegion.map(m => m.content).join(' ') + ' ' + cleanText)) {
    const monthName = monthOnlyMatch[1].toLowerCase();
    logInfo('[orchestrator] Month-only message detected, asking for days', { phoneNumber, month: monthName });
    const reply = `Perfeito, ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}! Quais dias você está pensando? Pode me dizer o período (ex: "5 a 10") que eu verifico a disponibilidade.`;
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply };
  }
  // Resposta à pergunta "quantas pessoas vão se hospedar?": retoma a consulta de disponibilidade
  // com as datas já informadas, em vez de cair na LLM e perder o que foi coletado.
  const askedGuestCount = historyForRegion.some(m => m.role === 'assistant' && /quantas pessoas v[aã]o se hospedar/i.test(m.content));
  const mentionsGuests = /(\d+)\s*(?:adultos?|pessoas?|crian[cç]as?)/i.test(cleanText) || /\b(dois|duas|tres|tr[eê]s|quatro|cinco|seis|sete|oito)\s+(?:adultos?|pessoas?)/i.test(cleanText);
  const guestAnswerAfterQuestion = askedGuestCount && mentionsGuests;
  // "sim"/"não" isolado costuma estar respondendo à pergunta sobre a região, não pedindo
  // disponibilidade. Sem esta guarda a conversa desviava para "me diz as datas".
  const lastAssistantText = [...historyForRegion].reverse().find(m => m.role === 'assistant' && m.content !== '[LOCATION_SENT]');
  // P2: Resposta à pergunta de região inclui confirmações E negações contextuais
  // "ainda não", "não conheço", "primeira vez" são respostas válidas quando o assistente perguntou sobre a região
  const regionQuestionPattern = /j[aá]\s+conhece|conhece\s+(?:a\s+)?(?:nossa\s+)?regi[aã]o|j[aá]\s+esteve|conhece\s+(?:a\s+)?pousada/i;
  const negativeRegionAnswer = /^(?:ainda\s+n[aã]o|n[aã]o\s+conhe[cç]o|nunca\s+(?:estive|fui)|primeira\s+vez|desconhe[cç]o)/i.test(cleanText);
  const answeredRegionQuestion = (isConfirmation || negativeRegionAnswer) && lastAssistantText
    && regionQuestionPattern.test(lastAssistantText.content);
if (offeredLocationAndAccepted && !locationAlreadySent) {
    const reply = 'Nosso endereço é Praça Bandeira, 10 - Passagem, Cabo Frio - RJ, 28906-320.';
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply, sendLocationAfterReply: true };
  }

  const state = getState(phoneNumber);
  // GATE DETERMINÍSTICO DA REGIÃO (Etapa 2C.6): se o cliente pediu disponibilidade/valor
  // e ainda não respondeu à pergunta sobre a região, BLOQUEIA o avanço e faz a pergunta.
  // Respostas à pergunta de região são tratadas ANTES deste gate (answeredRegionQuestion).
  const isAvailabilityOrQuoteRequest = detectAvailabilityRequest(cleanText) || detectQuoteRequest(cleanText);
  // Criança citada sem idade: o fluxo precisa perguntar a idade antes de cotar. O gate da
  // região não pode engolir essa pergunta de coleta — ele volta a valer quando o valor for gerado.
  const childAgesMissingForGate = (state.children || 0) > ((state.childrenAges || []).length);
  // Disponibilidade ou cotação já entregues: perguntar a região agora inverteria a ordem
  // (a pergunta sairia depois do orçamento e engoliria a resposta do cliente à cotação).
  const alreadyAdvancedPastRegionGate = !!state.lastAvailability || !!state.lastQuote || !!state.quotePresented;
  if (isAvailabilityOrQuoteRequest && !state.regionAsked && !answeredRegionQuestion && !childAgesMissingForGate && !alreadyAdvancedPastRegionGate) {
    logInfo('[orchestrator] Region gate: asking before availability', { phoneNumber });
    updateState(phoneNumber, { regionAsked: true });
    const reply = 'Antes de verificar a disponibilidade, me diz uma coisa: você já conhece nossa região aqui em Cabo Frio?';
    appendMessage(phoneNumber, 'assistant', reply);
    return { type: 'reply', content: reply };
  }

  // RESPOSTA À PERGUNTA DE REGIÃO: marca regionKnown e segue para coleta/disponibilidade
  if (answeredRegionQuestion && !state.regionKnown) {
    const knowsRegion = !/n[aã]o|desconhe[cç]o|nunca\s+fui|primeira\s+vez/i.test(cleanText);
    logInfo('[orchestrator] Region answer received', { phoneNumber, knowsRegion });
    updateState(phoneNumber, { regionKnown: true });
    if (!knowsRegion) {
      const ctxMsg = 'Que bom que vou te apresentar! Estamos na Praia do Forte, a praia mais famosa de Cabo Frio, ao lado do polo gastronômico e a 500m da areia. Dá para fazer tudo andando! 🏖️';
      const dateMsg = 'Agora me conta: para quais datas você está pensando?';
      // Ordem obrigatória: contextualização → localização (endereço+pin) → pergunta de datas
      const locatedCtx = withAvailabilityLocation(historyForRegion, ctxMsg, true);
      appendMessage(phoneNumber, 'assistant', locatedCtx.content);
      appendMessage(phoneNumber, 'assistant', dateMsg);
      return { type: 'multi_reply', contents: [locatedCtx.content, dateMsg], sendLocationAfterReply: locatedCtx.sendLocationAfterReply };
    }
    // Se conhece a região, cai no fluxo normal abaixo (recuperação de datas/disponibilidade)
  }

  // Se a mensagem atual não tem datas mas é confirmação, pedido de disponibilidade OU resposta de mês,
  // busca datas no histórico completo para evitar pedir novamente ao cliente
  // Usa estado estruturado como fonte primária para datas do histórico;
    // fallback regex só para conversas antigas sem estado persistido
    if (!hasDates && !answeredRegionQuestion && (isConfirmation || isMonthResponseOrConfirmation || (guestAnswerAfterQuestion && (conversationState.checkIn || extractDates(historyForRegion.map(m => m.content).join(' ')))))) {
      // Só recupera datas do histórico se NÃO for uma pergunta genérica de disponibilidade
      // "tem vaga?", "vocês tem vaga?" sem datas na mensagem atual NÃO deve usar datas de sessões anteriores
      const isGenericAvailabilityQuery = /(?:voc[eê]s?\s+)?(?:tem|têm|h[aá])\s+(?:vaga|quarto|disponib)/i.test(cleanText) && !extractDates(cleanText);
      if (!isGenericAvailabilityQuery) {
        // Fonte primária: estado estruturado; fallback: regex no histórico textual
        const historyText = historyForRegion.map(m => m.content).join(' ');
        if (conversationState.checkIn && conversationState.checkOut) {
          hasDates = { checkIn: conversationState.checkIn, checkOut: conversationState.checkOut };
        } else {
          hasDates = extractDates(historyText);
        }
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
  // C2: selectedRoomFromText devolve OBJETO do catálogo; state.selectedRoom é STRING (nome).
  // Misturar os dois fazia room.name/.capacity virarem undefined (cotação sem suíte).
  // "roomMentionedInText" é o sinal de intenção: só reentra na cotação se a mensagem
  // ATUAL fala de suíte. state.selectedRoom serve para cotar, não para decidir reentrar —
  // senão qualquer mensagem depois da disponibilidade recotava e repetia o orçamento.
  const roomMentionedInText = selectedRoomFromText(cleanText);
  const selectedRoom = roomMentionedInText || roomByName(state.selectedRoom) || null;
  const anyRoomAccepted = ANY_ROOM_PATTERN.test(cleanText);
  // availabilityShown agora armazena os parâmetros da última consulta (não mais booleano).
  // Permite nova consulta quando datas ou hóspedes mudam; bloqueia apenas consultas idênticas.
  const lastAvailabilityParams = state.lastAvailability ? state.lastAvailability.params : null;
  const availabilityShown = !!lastAvailabilityParams;

  if (quoteIntent || (availabilityShown && (roomMentionedInText || anyRoomAccepted))) {
    // Usa estado estruturado como fonte primária; mensagem atual já foi integrada na FASE 0
    const freshState = getState(phoneNumber);
    let quoteDates = extractDates(cleanText) || (freshState.checkIn && freshState.checkOut ? { checkIn: freshState.checkIn, checkOut: freshState.checkOut } : null);
    const quoteGuests = {
      adults: freshState.adults != null ? freshState.adults : 0,
      children: freshState.children != null ? freshState.children : 0,
      ages: freshState.childrenAges || [],
    };
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

    // Só consulta se os parâmetros forem diferentes da última consulta (ou se nunca consultou).
    const currentParams = { checkIn: quoteDates.checkIn, checkOut: quoteDates.checkOut, guests: totalGuestsForQuote, room: selectedRoom ? selectedRoom.name : null, ages: (quoteGuests.ages || []).join(',') };
    const paramsChanged = !lastAvailabilityParams
      || lastAvailabilityParams.checkIn !== currentParams.checkIn
      || lastAvailabilityParams.checkOut !== currentParams.checkOut
      || lastAvailabilityParams.guests !== currentParams.guests
      || lastAvailabilityParams.room !== currentParams.room
      || lastAvailabilityParams.ages !== currentParams.ages;
    if (paramsChanged) {
      const result = await checkAvailability(quoteDates.checkIn, quoteDates.checkOut, totalGuestsForQuote);
      logInfo('[orchestrator] Availability checked for quote', { phoneNumber, available: result && result.available });
      // Só registra o marcador APÓS consulta bem-sucedida; falha permite nova tentativa com mesmos parâmetros.
      if (result && result.available === true) {
        appendMessage(phoneNumber, 'assistant', `[AVAILABILITY_CHECK:${JSON.stringify(currentParams)}]`);
        persistResult(phoneNumber, 'availability', currentParams, { available: true, roomCount: result.availableRooms ? result.availableRooms.length : null });
      }
      if (!result || result.available !== true) {
        const reply = formatAvailabilityReply(result || {}, quoteDates.checkIn, quoteDates.checkOut, totalGuestsForQuote, selectedRoom);
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
      state: freshState,
    });

	if (quote) {
      const located = withAvailabilityLocation(historyForRegion, quote.content, false);
      appendMessage(phoneNumber, 'assistant', located.content);
      persistResult(phoneNumber, 'quote', { checkIn: quoteDates.checkIn, checkOut: quoteDates.checkOut, adults: quoteGuests.adults, childrenAges: quoteGuests.ages, room: roomForQuote ? roomForQuote.name : null }, { total: quote.total, nights: quote.nights });
      await humanDelay();
      // quotePresented só é marcado pelo server depois que o WhatsApp confirma a entrega.
      return { type: 'reply', content: located.content, sendLocationAfterReply: located.sendLocationAfterReply, quoteGenerated: true };
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

  // Porto de saída do bloco de cotação: o cliente viu a cotação quando
  // quotePresented == true. "sim"/"ok" após esse ponto é confirmação de leitura,
  // não intenção de reserva — não dispara handoff automaticamente.
  const quoteState = getState(phoneNumber);
  const quoteIsPresented = !!(quoteState.quotePresented);
  const hasQuoteInState = !!(quoteState.quoteGenerated);
  // Datas efetivas do fluxo comercial: a mensagem atual pode não repetir as datas
  // ("Gostei", "pode ser"), então vale o que está persistido no estado.
  const quoteFlowDates = hasDates
    || (quoteState.checkIn && quoteState.checkOut ? { checkIn: quoteState.checkIn, checkOut: quoteState.checkOut } : null);

  if (quoteIsPresented && quoteFlowDates) {
    const normalizedClean = normalizeForMatch(cleanText);
    const isExplicitReserve = EXPLICIT_RESERVE_PATTERN.test(cleanText) && !RESERVE_NEGATION_PATTERN.test(cleanText);
    const isGenericAck = /^(?:ok|perfeito|entendi|obrigado|valeu|blz|beleza|show|top|legal|massa|tranquilo|t[aá]|combinado|certo)$/i.test(cleanText.trim());
    // "sim" isolado é confirmação de resumo, não intenção de reserva:
    // trata como genérico para não handoffar por "sim" acidental.
    const isSim = /^\s*sim\s*$/i.test(cleanText.trim());
    const isConfirmacao = CONFIRMATION_PATTERN.test(cleanText.trim());
    const isConfirmOfSummary = isSim || isConfirmacao;

    // Handoff comercial: cliente viu cotação, confirmou interesse e
    // agora confirma o resumo da reserva — handoffConfirmed é a segunda trava.
    if (isConfirmOfSummary && !quoteState.handoffConfirmed) {
      const summaryAskedYet = historyForRegion.some(
        (m) => m.role === 'assistant' && /posso\s+encaminhar/i.test(m.content)
      );
      if (summaryAskedYet) {
        logInfo('[orchestrator] Summary confirmed, triggering handoff', { phoneNumber });
        markHandoffConfirmed(phoneNumber);
        const reply = 'Perfeito! Já estou encaminhando para nosso especialista confirmar sua reserva. Um momento! ✨';
        appendMessage(phoneNumber, 'assistant', reply);
        await humanDelay();
        triggerHandoff(phoneNumber, 'confirmado_pelo_cliente');
        return { type: 'reply', content: reply };
      }
      // Ainda não pediu confirmação: mostra o resumo que tem valor real.
      const summaryReply = buildHandoffSummary({
        phoneNumber,
        pushName,
        history: historyForRegion,
        checkIn: quoteFlowDates.checkIn,
        checkOut: quoteFlowDates.checkOut,
      });
      if (!summaryReply) {
        logInfo('[orchestrator] Handoff blocked: no valid presented quote for current data', { phoneNumber });
        const fallback = 'Preciso confirmar o valor exato antes de encaminhar. Um momento!';
        appendMessage(phoneNumber, 'assistant', fallback);
        return { type: 'reply', content: fallback };
      }
      appendMessage(phoneNumber, 'assistant', summaryReply);
      return { type: 'reply', content: summaryReply };
    }

    // Intenção explícita de reserva → gerar resumo se ainda não viu
    if (isExplicitReserve) {
      const summaryAskedYet = historyForRegion.some(
        (m) => m.role === 'assistant' && /posso\s+encaminhar/i.test(m.content)
      );
      if (summaryAskedYet) {
        logInfo('[orchestrator] Explicit reserve after summary, triggering handoff', { phoneNumber });
        markHandoffConfirmed(phoneNumber);
        const reply = 'Perfeito! Já estou encaminhando para nosso especialista confirmar sua reserva. Um momento! ✨';
        appendMessage(phoneNumber, 'assistant', reply);
        await humanDelay();
        triggerHandoff(phoneNumber, 'confirmado_pelo_cliente');
        return { type: 'reply', content: reply };
      }
      logInfo('[orchestrator] Explicit reserve intent after quote, generating handoff summary', { phoneNumber });
      const summaryReply = buildHandoffSummary({
        phoneNumber,
        pushName,
        history: historyForRegion,
        checkIn: quoteFlowDates.checkIn,
        checkOut: quoteFlowDates.checkOut,
      });
      if (!summaryReply) {
        logInfo('[orchestrator] buildHandoffSummary returned null (no valid quote), skipping handoff message', { phoneNumber });
        const fallback = 'Preciso confirmar o valor exato antes de encaminhar. Um momento!';
        appendMessage(phoneNumber, 'assistant', fallback);
        return { type: 'reply', content: fallback };
      }
      appendMessage(phoneNumber, 'assistant', summaryReply);
      return { type: 'reply', content: summaryReply };
    }

    // Aprovação da cotação ("Gostei", "Ficou bom", "Pode ser"): leva ao resumo
    // de confirmação em vez de repetir o orçamento. Handoff só depois do resumo.
    const isQuoteApproval = QUOTE_APPROVAL_PATTERN.test(cleanText.trim());
    if (isQuoteApproval && !quoteState.handoffConfirmed) {
      const summaries = historyForRegion.filter((m) => m.role === 'assistant' && /posso\s+encaminhar/i.test(m.content));
      if (summaries.length === 0) {
        logInfo('[orchestrator] Quote approved, generating handoff summary', { phoneNumber });
        const summaryReply = buildHandoffSummary({
          phoneNumber,
          pushName,
          history: historyForRegion,
          checkIn: quoteFlowDates.checkIn,
          checkOut: quoteFlowDates.checkOut,
        });
        if (summaryReply) {
          appendMessage(phoneNumber, 'assistant', summaryReply);
          return { type: 'reply', content: summaryReply };
        }
      }
    }

    // Confirmação genérica pós-cotação → mantém conversa aberta
    if (isGenericAck) {
      logInfo('[orchestrator] Generic acknowledgment after quote, keeping conversation open', { phoneNumber });
      const reply = 'Que bom! Ficou alguma dúvida sobre a proposta ou deseja seguir com a reserva?';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }
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
      // Usa estado estruturado como fonte primária para hóspedes em confirmações
      const confirmState = getState(phoneNumber);
      const confirmedAdults = confirmState && confirmState.adults != null ? confirmState.adults : 0;
      const confirmedChildren = confirmState && confirmState.children != null ? confirmState.children : 0;
      const hasGuestsInHistory = (confirmedAdults + confirmedChildren) > 0;
      // Fonte primária: estado estruturado; fallback: regex no histórico textual
      const recoveredDates = (confirmState && confirmState.checkIn && confirmState.checkOut)
        ? { checkIn: confirmState.checkIn, checkOut: confirmState.checkOut }
        : extractDates(historyForRegion.map(m => m.content).join(' '));
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
        // Usa estado estruturado para hóspedes na consulta após promessa
        const qAdults = confirmState && confirmState.adults != null ? confirmState.adults : 0;
        const qChildren = confirmState && confirmState.children != null ? confirmState.children : 0;
        const qTotal = (qAdults + qChildren) || undefined;
        const result = await checkAvailability(finalCheckIn, finalCheckOut, qTotal);
        if (!result || result.error || result.available == null) {
          return await handoffAfterFailure(phoneNumber, 'falha_consulta_disponibilidade');
        }
        if (result.available === true) {
          const located = withAvailabilityLocation(historyForRegion, formatAvailabilityReply(result, finalCheckIn, finalCheckOut, qTotal, selectedRoom), false);
          appendMessage(phoneNumber, 'assistant', located.content);
          return { type: 'reply', content: located.content, sendLocationAfterReply: located.sendLocationAfterReply };
        } else {
          const reply = formatAvailabilityReply(result, finalCheckIn, finalCheckOut, qTotal, selectedRoom);
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
        // Bloqueio 2C.7: se cotação ainda não foi apresentada, gerar cotação antes do resumo de confirmação
        const currentStateForConfirm = getState(phoneNumber);
        if (!currentStateForConfirm.quotePresented && recoveredDates.checkIn && recoveredDates.checkOut) {
          const roomForQuoteBeforeConfirm = roomByName(currentStateForConfirm.selectedRoom);
          if (roomForQuoteBeforeConfirm) {
            const quoteBeforeConfirm = buildQuoteReply({ history: getHistory(phoneNumber), checkIn: recoveredDates.checkIn, checkOut: recoveredDates.checkOut, room: roomForQuoteBeforeConfirm, state: currentStateForConfirm });
            if (quoteBeforeConfirm) {
// quotePresented é marcado pelo server após entrega real no WhatsApp (markQuotePresented)
              appendMessage(phoneNumber, 'assistant', quoteBeforeConfirm.content);
              return { type: 'reply', content: quoteBeforeConfirm.content };
            }
          }
        }
        const summaryReply = buildHandoffSummary({
          phoneNumber,
          pushName,
          history: getHistory(phoneNumber),
          checkIn: recoveredDates.checkIn,
          checkOut: recoveredDates.checkOut,
	        });
	        if (!summaryReply) {
	          logInfo('[orchestrator] buildHandoffSummary returned null after recovered dates, skipping handoff message', { phoneNumber });
	          const fallback = 'Preciso confirmar o valor exato antes de encaminhar. Um momento!';
	          appendMessage(phoneNumber, 'assistant', fallback);
	          return { type: 'reply', content: fallback };
	        }
	        appendMessage(phoneNumber, 'assistant', summaryReply);
	        return { type: 'reply', content: summaryReply };
      } else if (!hasDates) {
        logInfo('[orchestrator] No dates found in message or history, asking user', { phoneNumber });
        // Fonte primária: estado estruturado; fallback: regex no histórico textual
        const freshStateForAsk = getState(phoneNumber);
        const hasNoDates = !(freshStateForAsk && freshStateForAsk.checkIn) && !extractDates(historyForRegion.map(m => m.content).join(' '));
        // Se o cliente já mencionou um mês (ex: "dezembro"), NÃO usar modo consultivo nem falar de temporadas.
        // Pedir os dias diretamente — isso evita a resposta errada quando o cliente diz "tem vaga para dezembro?".
        const mentionedMonth = /\b(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i.test(cleanText + ' ' + historyForRegion.map(m => m.content).join(' '));
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

    // Usa estado estruturado como fonte de verdade para hóspedes (Etapa 2C.2)
    const currentState = getState(phoneNumber);
    let adults = currentState.adults || 0;
    let children = currentState.children || 0;
    // Fallback regex apenas quando o estado não tiver dados (conversa antiga sem hidratação)
    if (!adults && !children) {
      const historyForGuests = getHistory(phoneNumber);
      const guestText = historyForGuests.map(m => m.content).join(' ');
      const allAdultMatches = [...guestText.matchAll(/(\d+)\s*(?:adultos?|pessoas?)/gi)];
      const allDoisMatches = [...guestText.matchAll(/(?:dois|2)\s+adultos?/gi)];
      const lastAdultMatch = allAdultMatches.pop();
      const lastDoisMatch = allDoisMatches.pop();
      if (lastAdultMatch && lastAdultMatch[1]) adults = parseInt(lastAdultMatch[1], 10);
      else if (lastDoisMatch) adults = 2;
      const allChildMatches = [...guestText.matchAll(/(\d+)\s*(?:crian[cç]as?|kids?)/gi)];
      const lastChildMatch = allChildMatches.pop();
      if (lastChildMatch && lastChildMatch[1]) children = parseInt(lastChildMatch[1], 10);
    }
    const totalGuests = (adults + children) || undefined;

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
    const located = withAvailabilityLocation(historyForRegion, formatAvailabilityReply(result, finalCheckIn, finalCheckOut, totalGuests, selectedRoom), false);
    // Registra os parâmetros consultados: sem isso a cotação seguinte repete a consulta
    // à HospedInn com os mesmos dados (e o certo é reaproveitar o que já foi verificado).
    if (result.available === true) {
      // C1: grava as datas VALIDADAS (ano corrigido, mês completado) no estado — a FASE 0
      // só grava a data crua da mensagem, então sem isso check_in fica null e a cotação
      // seguinte pede as datas de novo, mesmo tendo acabado de consultá-las.
      // Precisa vir ANTES do persistResult: mudar datas invalida a disponibilidade anterior.
      try {
        updateState(phoneNumber, { checkIn: finalCheckIn, checkOut: finalCheckOut });
      } catch (e) {
        logWarn('[orchestrator] updateState failed persisting validated dates', { phoneNumber, error: e.message });
      }
      // Registra os parâmetros consultados: sem isso a cotação seguinte repete a consulta
      // à HospedInn com os mesmos dados (e o certo é reaproveitar o que já foi verificado).
      persistResult(phoneNumber, 'availability', { checkIn: finalCheckIn, checkOut: finalCheckOut, guests: totalGuests, room: selectedRoom ? selectedRoom.name : null, ages: ((currentState.childrenAges || []).join(',')) }, { available: true, roomCount: result.availableRooms ? result.availableRooms.length : null });
    }
    const reply = located.content;
    const sendLocationAfterReply = located.sendLocationAfterReply;

    // Divide a resposta em duas mensagens para humanizar: confirmação + recomendações
    const splitPoint = reply.indexOf('\n\n🏡');
    if (splitPoint > 0 && result.available === true) {
      let msg1 = reply.substring(0, splitPoint).trim();
      let msg2 = reply.substring(splitPoint).trim();
      // Sanitizador WhatsApp: remove --- e protege contra alucinação em multi_reply
      const WHATSAPP_SEP = /^\s*-{3,}\s*$/gm;
      msg1 = msg1.replace(WHATSAPP_SEP, '').replace(/\n{3,}/g, '\n\n').trim();
      msg2 = msg2.replace(WHATSAPP_SEP, '').replace(/\n{3,}/g, '\n\n').trim();
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

// BLOQUEIO DE PREÇOS PELA LLM (Etapa 2C.6): se o cliente pediu valor/preço/cotação
  // e chegou até aqui sem passar pelo fluxo estruturado, NÃO permite que a LLM invente valores.
  // Força handoff ou pergunta por dados faltantes.
  const quoteIntentInFallback = detectQuoteRequest(cleanText);
  if (quoteIntentInFallback) {
    const blockState = getState(phoneNumber);
    const blockRoom = selectedRoomFromText(cleanText) || roomByName(blockState.selectedRoom) || null;
    const hasBlockDates = !!(blockState.checkIn && blockState.checkOut);
    const hasBlockGuests = blockState.adults != null && blockState.adults > 0;

    if (!blockRoom) {
      logInfo('[orchestrator] Quote intent without room in LLM fallback, asking for room', { phoneNumber });
      const reply = 'Para eu te passar o valor certinho, qual suíte você prefere? Posso recomendar as melhores opções para o seu grupo se quiser!';
      appendMessage(phoneNumber, 'assistant', reply);
      return { type: 'reply', content: reply };
    }
    if (!hasBlockDates || !hasBlockGuests) {
      logInfo('[orchestrator] Quote intent without dates/guests in LLM fallback, handing off', { phoneNumber });
      const reply = 'Preciso confirmar alguns detalhes antes de te passar o valor exato. Já estou encaminhando para nosso especialista verificar a melhor tarifa para você!';
      appendMessage(phoneNumber, 'assistant', reply);
      await humanDelay();
      triggerHandoff(phoneNumber, 'cotacao_sem_dados_completos');
      return { type: 'reply', content: reply };
    }
    // Dados completos mas não passou pelo fluxo estruturado: força consulta via pricing.js
    logInfo('[orchestrator] Quote intent with full data in LLM fallback, forcing structured quote', { phoneNumber });
    const forcedResult = await checkAvailability(blockState.checkIn, blockState.checkOut, blockState.adults + (blockState.children || 0));
    if (!forcedResult || forcedResult.error || forcedResult.available == null) {
      return await handoffAfterFailure(phoneNumber, 'falha_consulta_disponibilidade_fallback');
    }
    const forcedQuote = buildQuoteReply({ history: historyForRegion, checkIn: blockState.checkIn, checkOut: blockState.checkOut, room: blockRoom, state: blockState });
	    if (forcedQuote && forcedQuote.content) {
	      appendMessage(phoneNumber, 'assistant', forcedQuote.content);
	      return { type: 'reply', content: forcedQuote.content };
    }
    // Se buildQuoteReply falhar, handoff seguro
    const safeReply = 'Estou verificando o valor exato da sua reserva. Um momento que já te confirmo!';
    appendMessage(phoneNumber, 'assistant', safeReply);
    await humanDelay();
    triggerHandoff(phoneNumber, 'cotacao_estrutura_falhou');
    return { type: 'reply', content: safeReply };
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
    ...history
      .filter((m) => !/^\[AVAILABILITY_CHECK:/.test(m.content))
      .map((m) => ({ role: m.role, content: m.content })),
  ];

  logInfo('[orchestrator] Calling LLM API', { phoneNumber, messageCount: messages.length });
  const llmReply = await callLLM(messages);
  logInfo('[orchestrator] LLM API returned', { phoneNumber, responseLength: llmReply?.length ?? 0, isFallback: !llmReply });
  const reply = llmReply || FALLBACK_MESSAGE;

  // P4: Bloqueio de promessas vazias — se a LLM promete consultar mas não há dados suficientes,
  // substitui a promessa por solicitação dos dados faltantes em vez de deixar o cliente sem retorno.
  const PROMISE_PATTERN_PRECHECK = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  if (llmReply && PROMISE_PATTERN_PRECHECK.test(llmReply)) {
    const precheckState = getState(phoneNumber);
    const hasDates = !!(precheckState && precheckState.checkIn && precheckState.checkOut);
    const hasGuests = !!(precheckState && precheckState.adults != null && precheckState.adults > 0);
    if (!hasDates || !hasGuests) {
      logInfo('[orchestrator] P4: blocking empty promise from LLM', { phoneNumber, hasDates, hasGuests });
      const missingParts = [];
      if (!hasDates) missingParts.push('as datas');
      if (!hasGuests) missingParts.push('quantas pessoas vão se hospedar');
      const askMissing = `Para eu verificar a disponibilidade, preciso saber ${missingParts.join(' e ')}. Pode me informar?`;
      appendMessage(phoneNumber, 'assistant', askMissing);
      return { type: 'reply', content: askMissing };
    }
  }

  // REQUISITO 1.3: a LLM às vezes responde "vou consultar" sem que a consulta aconteça — e aí
  // o cliente fica sem retorno para sempre. Com datas e hóspedes completos, executa a consulta
  // aqui e entrega o resultado real no lugar da promessa.
  const PROMISE_PATTERN = /vou\s+(?:consultar|verificar|checar|conferir)|consultar\s+a\s+disponibilidade|verificar\s+a\s+disponibilidade|checar\s+a\s+disponibilidade|verificando\s+a\s+disponibilidade|um\s+momento/i;
  // Se a disponibilidade já foi entregue nesta conversa, repetir a consulta só duplicaria a lista de suítes.
  const availabilityAlreadyDelivered = historyForRegion.some(m => m.role === 'assistant' && /comportam seu grupo|op[cç][oõ]es de su[ií]tes|quartos? dispon[ií]vel/i.test(m.content));
  if (llmReply && !availabilityAlreadyDelivered && !HANDOFF_SENT_PATTERN.test(reply) && PROMISE_PATTERN.test(reply)) {
    // Usa estado estruturado como fonte primária para promessa da LLM
    const promiseState = getState(phoneNumber);
    const promisedDates = extractDates(cleanText) || (promiseState && promiseState.checkIn && promiseState.checkOut ? { checkIn: promiseState.checkIn, checkOut: promiseState.checkOut } : null);
    const promisedAdults = promiseState && promiseState.adults != null ? promiseState.adults : 0;
    const promisedChildrenCount = promiseState && promiseState.children != null ? promiseState.children : 0;
    const promisedGuests = promisedAdults + promisedChildrenCount;
    const promisedAges = (promiseState && promiseState.childrenAges) || [];
    if (promisedDates && promisedGuests > 0 && promisedChildrenCount <= promisedAges.length) {
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
  const firstBlockHasContext = LOCATION_CONTEXT_PATTERN.test(replyBlocks ? replyBlocks[0] : reply);
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


  // Proteção 2C.8: sanitizar placeholders não resolvidos antes do envio
  const PLACEHOLDER_PATTERN = /\[valor exato da cota[çc][aã]o(?:[^\]]*)\]|\[(?:nome|telefone|data|su[ií]te|n[ºo°]?\s*(?:adultos|crian[cç]as))\]/gi;
  let safeReply = locationReply;
  if (PLACEHOLDER_PATTERN.test(safeReply)) {
    logWarn('[orchestrator] Placeholder detected in reply, blocking and using fallback', { phoneNumber, match: safeReply.match(PLACEHOLDER_PATTERN) });
    // Tenta recuperar cotação válida do estado antes de usar fallback genérico
    const recoveryState = getState(phoneNumber);
    const recoveryRoom = recoveryState && recoveryState.selectedRoom ? roomByName(recoveryState.selectedRoom) : null;
    if (recoveryState && recoveryState.checkIn && recoveryState.checkOut && (recoveryState.adults > 0 || recoveryState.children > 0)) {
      const recoveredQuote = buildQuoteReply({ history: historyForRegion, checkIn: recoveryState.checkIn, checkOut: recoveryState.checkOut, room: recoveryRoom, state: recoveryState });
      if (recoveredQuote && recoveredQuote.content && !PLACEHOLDER_PATTERN.test(recoveredQuote.content)) {
        safeReply = recoveredQuote.content;
        logInfo('[orchestrator] Quote recovered successfully after placeholder block', { phoneNumber });
      } else {
        safeReply = 'Estou confirmando o valor exato da sua reserva. Um momento que já te passo todos os detalhes!';
      }
    } else {
      safeReply = 'Preciso confirmar alguns detalhes para te passar o valor correto. Já estou verificando!';
    }
  }

  // SANITIZADOR WHATSAPP: remove separadores artificiais --- antes do envio.
  // A divisão em blocos acontece ANTES de remover o separador, senão a informação
  // de onde dividir se perde e tudo vira uma mensagem só.
  const WHATSAPP_SEPARATOR_PATTERN = /^\s*-{3,}\s*$/gm;
  const safeBlocks = safeReply
    .split(/\n?-{3,}\n?/)
    .map((b) => b.replace(WHATSAPP_SEPARATOR_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean);
  let finalReplyBlocks = safeBlocks.length > 1 ? safeBlocks : null;
  let whatsappSafeReply = safeBlocks.length > 1 ? safeBlocks.join('\n\n') : (safeBlocks[0] || '');

  // PROTEÇÃO FINAL CONTRA ALUCINAÇÃO: valida dados antes do envio
  const HAS_AVAILABILITY_CLAIM = /dispon[ií]vel|su[ií]te|quarto|apartamento|R\$\s*\d/i.test(whatsappSafeReply);
  const hasValidStateForQuote = state.checkIn && state.checkOut && (state.adults > 0) && state.selectedRoom;
  if (HAS_AVAILABILITY_CLAIM && !hasValidStateForQuote && !state.quotePresented) {
    logWarn('[orchestrator] Hallucination blocked: availability claim without valid state', { phoneNumber });
    whatsappSafeReply = 'Estou verificando a disponibilidade exata para você. Um momento!';
    finalReplyBlocks = null;
  }

  // Aplica delay humano antes de retornar resposta da LLM
  await humanDelay();
  logInfo('[orchestrator] processMessage returning', { phoneNumber, resultType: finalReplyBlocks ? 'multi_reply' : 'reply', content: whatsappSafeReply.substring(0, 100) });
  if (finalReplyBlocks) {
    finalReplyBlocks.forEach((b) => appendMessage(phoneNumber, 'assistant', b));
    return { type: 'multi_reply', contents: finalReplyBlocks, sendLocationAfterReply };
  }
  appendMessage(phoneNumber, 'assistant', whatsappSafeReply);
  return { type: 'reply', content: whatsappSafeReply, sendLocationAfterReply };
}

module.exports = { processMessage, formatAvailabilityReply };