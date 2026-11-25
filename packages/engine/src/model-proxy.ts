import { isBrainEffort } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import {
  agentOutputTokens,
  type ContentBlock,
  isAutoModel,
  type ModelMessage,
  ProviderError,
  type StopReason,
  type SystemBlock,
  type ToolSpec,
} from "@agenteschat/providers";
import { getAgent } from "./agents";
import { accountablePerson, runAuthority } from "./authority";
import { turnEffort } from "./brains/model";
import {
  BudgetExceededError,
  ForbiddenError,
  MissingCredentialError,
  NotFoundError,
  PersonLimitError,
  ValidationError,
} from "./errors";
import type { ModelGateway } from "./gateway";

/**
 * The server's OpenAI-compatible model proxy (ADR 9007). An agent that thinks with an API key runs its turns on
 * OpenCode on a computer; OpenCode's one provider points here, with the turn's run tool token as its bearer, so the
 * key never leaves the server. Every call goes through the Model Gateway (budget reserved first, tokens and cost
 * recorded for the org, agent, run and person), with the agent's own model and effort for that run: the model name
 * OpenCode sends is ignored.
 */
export interface ModelProxyDeps {
  db: Database;
  gateway: Pick<ModelGateway, "stream">;
  /** The server's cap (`AGENT_MAX_OUTPUT_TOKENS`), as the in-process brain takes it. */
  maxOutputTokens?: number;
  /** Where a provider's refusal is told (status and words, never a key). */
  log?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

/**
 * What a provider returned that the OpenAI format can't carry (Gemini's thought steps with their signatures), kept per
 * run by the call id it came with and put back before that call when OpenCode sends the history again. Without it
 * Gemini refuses the next call of a tool loop. In memory (shortcut: not shared between server replicas and lost on a
 * restart; upgrade if proxied calls are balanced across replicas).
 */
const keptOpaque = new Map<string, Map<string, ContentBlock[]>>();
const KEPT_RUNS = 200;

function keepOpaque(runId: string, content: ContentBlock[]) {
  const byCall = new Map<string, ContentBlock[]>(keptOpaque.get(runId));
  let pending: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "opaque") pending.push(b);
    else if (b.type === "tool_use") {
      if (pending.length) byCall.set(b.id, pending);
      pending = [];
    }
  }
  if (byCall.size === 0) return;
  keptOpaque.delete(runId);
  keptOpaque.set(runId, byCall);
  for (const old of keptOpaque.keys()) {
    if (keptOpaque.size <= KEPT_RUNS) break;
    keptOpaque.delete(old);
  }
}

/** Who a proxied call is for: what the bearer's token says (`verifyRunToolTokenForProxy`). */
export interface ModelProxyIdentity {
  orgId: string;
  agentId: string;
  runId: string;
}

export type ModelProxyReply =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "sse"; stream: ReadableStream<Uint8Array> };

const error = (status: number, type: string, code: string, message: string): ModelProxyReply => ({
  kind: "json",
  status,
  body: { error: { message, type, code } },
});

/** A failure of the call, in the words OpenAI's clients read: budgets 402 (never retried), the provider's 502. */
export function proxyFailure(err: unknown): ModelProxyReply {
  if (err instanceof BudgetExceededError) return error(402, "insufficient_quota", "budget_exceeded", err.message);
  if (err instanceof PersonLimitError) return error(402, "insufficient_quota", "person_limit", err.message);
  if (err instanceof MissingCredentialError)
    return error(403, "invalid_request_error", "missing_credential", err.message);
  if (err instanceof ForbiddenError) return error(403, "invalid_request_error", "forbidden", err.message);
  if (err instanceof NotFoundError) return error(404, "invalid_request_error", "not_found", err.message);
  if (err instanceof ValidationError) return error(400, "invalid_request_error", "invalid_request", err.message);
  if (err instanceof ProviderError) {
    const status = err.retryable ? 503 : 502;
    return error(status, "api_error", err.retryable ? "provider_unavailable" : "provider_error", err.message);
  }
  throw err;
}

/** `GET /v1/models`: the one model a proxied turn names. */
export const proxyModels = () => ({
  object: "list",
  data: [{ id: "agent", object: "model", created: 0, owned_by: "squadchat" }],
});

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** An OpenAI message list as the gateway takes it: system text apart, tool results as `tool_result` blocks, roles alternating. */
export function translateMessages(
  raw: unknown[],
  kept?: Map<string, ContentBlock[]>,
): { system: SystemBlock[]; messages: ModelMessage[] } {
  const system: SystemBlock[] = [];
  const messages: ModelMessage[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) {
      last.content = [
        ...(typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content),
        ...blocks,
      ];
    } else messages.push({ role, content: blocks });
  };
  for (const m of raw) {
    if (!isRecord(m)) continue;
    const content = m.content;
    // Text parts; a picture can't be sent on (the gateway has no image block for a person's words), so it is said.
    const text = Array.isArray(content)
      ? content
          .map((p) =>
            isRecord(p) && p.type === "text"
              ? str(p.text)
              : isRecord(p) && p.type === "image_url"
                ? "[a picture was left out]"
                : "",
          )
          .filter(Boolean)
          .join("\n")
      : str(content);
    if (m.role === "system" || m.role === "developer") {
      if (text) system.push({ text });
    } else if (m.role === "user") {
      if (text) push("user", [{ type: "text", text }]);
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = text ? [{ type: "text", text }] : [];
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(str(call.function.arguments) || "{}");
          if (isRecord(parsed)) input = parsed;
        } catch {
          // The model's own malformed arguments: sent back as no input, as they ran.
        }
        blocks.push(...(kept?.get(str(call.id)) ?? []));
        blocks.push({ type: "tool_use", id: str(call.id), name: str(call.function.name), input });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", toolUseId: str(m.tool_call_id), content: text }]);
    }
  }
  // The conversation starts with a person's turn.
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: "(continue)" });
  const last = system.at(-1);
  if (last) last.cache = true;
  return { system, messages };
}

/** OpenAI's `tools` as the gateway's specs. */
export function translateTools(raw: unknown): ToolSpec[] | undefined {
  const specs = (Array.isArray(raw) ? raw : []).flatMap((t): ToolSpec[] => {
    if (!isRecord(t) || !isRecord(t.function) || !str(t.function.name)) return [];
    return [
      {
        name: str(t.function.name),
        description: str(t.function.description),
        inputSchema: isRecord(t.function.parameters) ? t.function.parameters : { type: "object", properties: {} },
      },
    ];
  });
  return specs.length > 0 ? specs : undefined;
}

const FINISH: Record<StopReason, string> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  other: "stop",
};

const encoder = new TextEncoder();

/** What a run's agent thinks with now: its own model (`Automático`'s pick when it is auto) and effort. */
async function runModel(db: Database, identity: ModelProxyIdentity) {
  const [run] = await db
    .select({
      id: schema.agentRuns.id,
      orgId: schema.agentRuns.orgId,
      triggerMessageId: schema.agentRuns.triggerMessageId,
      background: schema.agentRuns.background,
      transcript: schema.agentRuns.transcript,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, identity.runId));
  const agent = await getAgent(db, identity.orgId, identity.agentId);
  if (!run || !agent || run.orgId !== identity.orgId) throw new NotFoundError("Run not found");
  const auto = isRecord(run.transcript?.autoModel) ? run.transcript.autoModel : null;
  const picked = isAutoModel(agent.model);
  const model = picked ? str(auto?.apiModel) : agent.model;
  if (!model) throw new ValidationError("The model for this run isn't chosen yet");
  const own = picked ? auto?.effort : agent.brainEffort;
  const personId = agent.builtin === "right_hand" ? null : accountablePerson(await runAuthority(db, run));
  return {
    agent: { ...agent, model },
    effort: turnEffort(model, isBrainEffort(own) ? own : undefined),
    personId,
  };
}

/**
 * `POST /v1/chat/completions`: one gateway call for the agent of `identity`'s run. Text streams as it comes; tool calls
 * and usage arrive with the call's end (the gateway returns them whole). A failure before anything was sent is an
 * HTTP error; after, an `error` event, then `[DONE]`.
 */
export async function proxyChat(
  deps: ModelProxyDeps,
  identity: ModelProxyIdentity,
  body: unknown,
  signal?: AbortSignal,
): Promise<ModelProxyReply> {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return error(400, "invalid_request_error", "invalid_request", "messages is required");
  }
  const fail = (err: unknown) => {
    if (err instanceof ProviderError) {
      deps.log?.warn("model proxy: provider refused the call", {
        runId: identity.runId,
        status: err.status,
        retryable: err.retryable,
        said: err.said,
        error: err.message,
      });
    }
    return proxyFailure(err);
  };
  try {
    const { agent, effort, personId } = await runModel(deps.db, identity);
    const { system, messages } = translateMessages(body.messages, keptOpaque.get(identity.runId));
    const tools = translateTools(body.tools);
    const streaming = body.stream === true;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Json, finish: string | null, extra: Json = {}) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: "agent",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        controller = undefined;
      },
    });
    let sent = false;
    let failure: { e: unknown } | null = null;
    let opened: () => void = () => {};
    const firstOrEnd = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const send = (data: unknown) => {
      sent = true;
      controller?.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
    };
    let first = true;
    const call = deps.gateway.stream({
      orgId: identity.orgId,
      agentId: identity.agentId,
      agent,
      runId: identity.runId,
      personId,
      system,
      messages,
      maxTokens: deps.maxOutputTokens ?? agentOutputTokens(agent.model, effort),
      ...(tools ? { tools } : {}),
      ...(effort ? { effort } : {}),
      cacheTtl: "1h",
      onDelta: (text) => {
        if (!streaming) return;
        // The role goes alone, as OpenAI's own streams start, so no words ride on the one chunk clients treat apart.
        if (first) send(chunk({ role: "assistant", content: "" }, null));
        send(chunk({ content: text }, null));
        first = false;
        opened();
      },
      ...(signal ? { signal } : {}),
    });
    const result = call.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    if (!streaming) {
      const done = await result;
      if (!done.ok) return fail(done.e);
      const { r } = done;
      keepOpaque(identity.runId, r.content);
      const calls = r.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }]
          : [],
      );
      return {
        kind: "json",
        status: 200,
        body: {
          id,
          object: "chat.completion",
          created,
          model: "agent",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: r.text || null, ...(calls.length ? { tool_calls: calls } : {}) },
              finish_reason: FINISH[r.stopReason],
            },
          ],
          usage: usageOf(r.usage),
        },
      };
    }
    void result.then((done) => {
      if (!done.ok) {
        failure = { e: done.e };
        // Nothing sent yet: the caller answers with the HTTP error, so the stream is dropped unread.
        if (sent) {
          let said: unknown = { error: { message: "The call failed", type: "api_error" } };
          try {
            const failed = fail(done.e);
            if (failed.kind === "json") said = failed.body;
          } catch {
            // An error that is none of the gateway's: told as a plain failure.
          }
          send(said);
          send("[DONE]");
          controller?.close();
        }
        opened();
        return;
      }
      const { r } = done;
      keepOpaque(identity.runId, r.content);
      const calls = r.content.flatMap((b) => (b.type === "tool_use" ? [b] : []));
      // A provider that sent no deltas (the words came whole) still gets its words said before the calls.
      if (first) {
        send(chunk({ role: "assistant", content: "" }, null));
        if (r.text) send(chunk({ content: r.text }, null));
      }
      if (calls.length > 0) {
        send(
          chunk(
            {
              tool_calls: calls.map((b, index) => ({
                index,
                id: b.id,
                type: "function",
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              })),
            },
            null,
          ),
        );
      }
      send(chunk({}, FINISH[r.stopReason], { usage: usageOf(r.usage) }));
      send("[DONE]");
      controller?.close();
      opened();
    });
    await firstOrEnd;
    if (failure && !sent) return fail((failure as { e: unknown }).e);
    return { kind: "sse", stream };
  } catch (err) {
    return fail(err);
  }
}

const usageOf = (u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}) => {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
  };
};
