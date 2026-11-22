import { turnMeans } from "../src";
import { continuationVerdict, decideTurnEnd } from "../src/continuation";
import type { Judge } from "../src/judge";

/**
 * A person's request and the reply an agent ended its turn with, in a conversation: `answered` when the person
 * already has what they need (a complete answer, a plain "I can't, because…" on a rule or a refusal, a question back
 * only they can answer), so no extra turn may follow; `nudged` when the turn left real work undone (a promise with
 * nothing done, a give-up with ways left, a step that only needs the person).
 */
export interface TurnEndCase {
  id: string;
  request: string;
  reply: string;
  tried: string[];
  means: string[];
  want: "answered" | "nudged";
}

const WEB = turnMeans(new Set(["web_search", "web_fetch", "run_code", "find_tools", "search_context"]));
const BROWSER = turnMeans(new Set(["web_search", "browser_do", "browser_ask_person", "search_context"]));

export const TURN_END_CASES: TurnEndCase[] = [
  {
    id: "privacy-rule-refusal",
    request: "@lia what is the email of the owner of the Example Co account?",
    reply:
      "I can't get that email. The support tools never return what customers typed, like emails or names: each one comes back as a code. That's a privacy rule built into the tools, so I won't pull the address out some other way. Someone with admin access to the support console can look it up there.",
    tried: ["support_find(example co) → failed: Nothing for that reference."],
    means: WEB,
    want: "answered",
  },
  {
    id: "system-refused-restart",
    request: "@lia reinicia o servidor de testes",
    reply:
      "Não reiniciei: o sistema recusou o pedido porque o servidor está bloqueado para manutenção, e liberar isso é decisão da equipe de infraestrutura. Pedir de novo daqui teria a mesma resposta.",
    tried: ["restart_server(test) → failed: refused: the server is locked for maintenance"],
    means: WEB,
    want: "answered",
  },
  {
    id: "greeting-back",
    request: "@lia bom dia",
    reply: "Bom dia, Marina! Em que posso te ajudar?",
    tried: [],
    means: WEB,
    want: "answered",
  },
  {
    id: "complete-answer",
    request: "@rui quantos clientes ativos temos no plano anual?",
    reply:
      "São 87 clientes ativos no plano anual. A lista tem 88; deixei de fora uma conta de teste. Só li os dados, não mudei nada.",
    tried: ["billing_list_customers(plan: annual) → 88 customers"],
    means: WEB,
    want: "answered",
  },
  {
    id: "which-one-question",
    request: "@ana manda o relatório pro time",
    reply: "Qual dos dois: o de vendas de novembro ou o de churn da semana?",
    tried: ["list_artifacts() → Vendas novembro; Churn semana 47"],
    means: WEB,
    want: "answered",
  },
  {
    id: "promise-nothing-done",
    request: "@otto why is the checkout slow since yesterday?",
    reply: "I'll look at the logs and the last deploy now and tell you what I find.",
    tried: [],
    means: WEB,
    want: "nudged",
  },
  {
    id: "one-empty-search",
    request: "@rui qual cartão sem anuidade o Banco Azul lançou?",
    reply: "Não achei nada sobre isso.",
    tried: ["web_search(banco azul cartão) → (empty)"],
    means: WEB,
    want: "nudged",
  },
  {
    id: "needs-person-qr",
    request: "@rui read my WhatsApp messages and tell me what Bia asked for",
    reply: "I can't read your WhatsApp: the web version needs you to scan a QR code with your phone.",
    tried: [],
    means: BROWSER,
    want: "nudged",
  },
];

const ORG = "00000000-0000-0000-0000-000000000000";

/** The production turn end for one case: whether it ends there (`answered`) or the run is sent on (`nudged`). */
export async function turnEndOf(judge: Judge, c: TurnEndCase) {
  const d = await decideTurnEnd({
    state: { count: 0 },
    kind: "conversation",
    executed: c.tried.length,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: c.reply,
    mission: false,
    wakesLater: async () => false,
    comesBack: async () => false,
    evidence: { means: c.means, tried: c.tried },
    verdict: () =>
      continuationVerdict(judge, {
        orgId: ORG,
        agentId: ORG,
        runId: ORG,
        request: c.request,
        reply: c.reply,
        means: c.means,
        tried: c.tried,
        runKind: "conversation",
      }),
  });
  return { got: d.outcome === "continue" ? ("nudged" as const) : ("answered" as const), rule: d.rule };
}
