/**
 * Fast, zero-network classification for trivial social turns ("oi", "bom dia",
 * "valeu", "thanks") and clean short replies, so simple greetings skip the
 * start judges, embedding lookup, git pre-sync, and turn-end judge.
 *
 * Strictly conservative: any uncertainty returns `false` and falls back to the
 * full judge and tool pipeline.
 */

const MENTION_PREFIX = /^(?:@"[^"]+"\s+|@[\w.-]+\s+)+/;
const URL_RE = /https?:\/\//i;
const DIGIT_RE = /\d/;
const NON_LETTER_RE = /[^\p{L}\s]/gu;
const MULTI_SPACE_RE = /\s+/g;

const QUICK_GREETINGS = new Set([
  // Portuguese
  "oi",
  "oii",
  "oiii",
  "oie",
  "ola",
  "olá",
  "opa",
  "eae",
  "e ai",
  "e aí",
  "fala",
  "salve",
  "bom dia",
  "boa tarde",
  "boa noite",
  "tudo bem",
  "tudo bom",
  "td bem",
  "como vai",
  "oi tudo bem",
  "ola tudo bem",
  "olá tudo bem",
  "oi tudo bom",
  "ola tudo bom",
  "olá tudo bom",
  "opa tudo bem",
  "eae tudo bem",
  "e ai tudo bem",
  "e aí tudo bem",
  "fala tudo bem",
  "bom dia tudo bem",
  "boa tarde tudo bem",
  "boa noite tudo bem",
  "obrigado",
  "obrigada",
  "obg",
  "valeu",
  "vlw",
  "brigado",
  "brigada",
  "de nada",
  "tmj",
  // Shared / English
  "hi",
  "hi there",
  "hey",
  "hey there",
  "hello",
  "hello there",
  "yo",
  "gm",
  "good morning",
  "good afternoon",
  "good evening",
  "thanks",
  "thank you",
  "thx",
  "ty",
  // Spanish
  "hola",
  "buenos dias",
  "buenos días",
  "buenas tardes",
  "buenas noches",
  "gracias",
]);

const GREETING_MAX_CHARS = 60;
const CLEAN_REPLY_MAX_CHARS = 350;

const PROMISE_WORK_RE =
  /\b(vou\s+(verificar|checar|olhar|buscar|procurar|fazer|rodar|conferir|analisar|abrir|enviar|criar|atualizar)|deixa\s+eu\s+(ver|checar|olhar)|um\s+momento|aguarde|i'?ll\s+(check|look|verify|run|do|fetch|search|open|send|create|update)|let\s+me\s+(check|look|verify|see)|one\s+moment|hang\s+on|working\s+on\s+it)\b/i;

const INABILITY_RE =
  /\b(não\s+(consigo|posso|tenho\s+acesso)|sem\s+acesso|i\s+can'?t|cannot\s+(access|do|see|read)|don'?t\s+have\s+access|unable\s+to)\b/i;

const CREDENTIAL_ASK_RE = /\b(senha|password|api[\s_-]?key|secret|token|credencial|credential)\b/i;

/** True when `raw` is a pure social greeting or acknowledgement with no task attached. */
export function isQuickGreeting(raw: string): boolean {
  const trimmed = raw.trim().replace(MENTION_PREFIX, "").trim();
  if (!trimmed || trimmed.length > GREETING_MAX_CHARS) return false;
  if (trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes("`")) return false;
  if (trimmed.includes("/") || trimmed.includes("\\") || URL_RE.test(trimmed)) return false;
  if (DIGIT_RE.test(trimmed)) return false;
  const normalized = trimmed.toLowerCase().replace(NON_LETTER_RE, " ").replace(MULTI_SPACE_RE, " ").trim();
  if (!normalized) return false;
  return QUICK_GREETINGS.has(normalized);
}

/** True when a short reply with zero tool calls can skip the turn-end judge safely. */
export function isQuickCleanReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > CLEAN_REPLY_MAX_CHARS) return false;
  if (trimmed.includes("```")) return false;
  if (PROMISE_WORK_RE.test(trimmed)) return false;
  if (INABILITY_RE.test(trimmed)) return false;
  if (CREDENTIAL_ASK_RE.test(trimmed)) return false;
  return true;
}
