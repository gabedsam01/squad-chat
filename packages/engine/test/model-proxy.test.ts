import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, MODEL_PROXY_MODEL, MODEL_PROXY_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  insertMessage,
  issueRunToolToken,
  type MachineStatus,
  proxyChat,
  proxyModels,
  resolveBrain,
  verifyRunToolTokenForProxy,
} from "../src";
import { turnEffort } from "../src/brains/model";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";

/**
 * The model proxy OpenCode thinks through (ADR 9007): OpenAI's wire format over the Model Gateway, and the choice of
 * a computer for an API-key agent's turn.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(() => f?.close());

async function runRow(status = "running") {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev oi",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: status as "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const identity = (run: { id: string }) => ({ orgId: f.org.id, agentId: f.agent.id, runId: run.id });
const deps = () => ({ db: f.db, gateway: f.gateway });

/** The `data:` lines of an event stream, parsed (`[DONE]` kept as text). */
async function events(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((e) => e.replace(/^data: /, ""))
    .map((e) => (e === "[DONE]" ? e : (JSON.parse(e) as Record<string, any>)));
}

test("a chat completion runs the agent's own model through the gateway and records its cost once", async () => {
  f = await setup({
    reply: () => ({ chunks: ["Hi", " there"], usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 } }),
  });
  const run = await runRow();
  const reply = await proxyChat(
    deps(),
    identity(run),
    {
      // The name OpenCode sends decides nothing.
      model: "gpt-9-whatever",
      messages: [
        { role: "system", content: "You are dev." },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      tools: [{ type: "function", function: { name: "search", description: "Find", parameters: { type: "object" } } }],
    },
  );
  if (reply.kind !== "json") throw new Error("expected json");
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1050, completion_tokens: 200, total_tokens: 1250 },
  });
  const request = f.provider.calls[0]?.request;
  expect(request?.model).toBe(f.agent.model);
  expect(request?.effort).toBe(turnEffort(f.agent.model, undefined));
  expect(request?.tools?.[0]?.name).toBe("search");
  expect(request?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  // The key is the gateway's own, never the request's.
  expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-test-key-1234");
  const records = await f.db.select().from(schema.usageRecords);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ orgId: f.org.id, agentId: f.agent.id, runId: run.id, provider: "anthropic" });
});

test("a streamed call with a tool: text deltas, the call, a finish with usage, and the result sent back", async () => {
  let n = 0;
  f = await setup({
    reply: () =>
      n++ === 0
        ? { chunks: ["Let me ", "look"], toolUses: [{ id: "call_1", name: "search", input: { q: "x" } }] }
        : { chunks: ["Found it"] },
  });
  const run = await runRow();
  const first = await proxyChat(deps(), identity(run), {
    stream: true,
    messages: [{ role: "user", content: "find x" }],
    tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
  });
  if (first.kind !== "sse") throw new Error("expected a stream");
  const list = await events(first.stream);
  expect(list.at(-1)).toBe("[DONE]");
  const chunks = list.slice(0, -1) as Record<string, any>[];
  expect(chunks[0]?.choices[0].delta).toEqual({ role: "assistant", content: "Let me " });
  expect(chunks[1]?.choices[0].delta).toEqual({ content: "look" });
  expect(chunks[2]?.choices[0].delta.tool_calls).toEqual([
    { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
  ]);
  const last = chunks.at(-1);
  expect(last?.choices[0].finish_reason).toBe("tool_calls");
  expect(last?.usage.completion_tokens).toBeGreaterThan(0);

  // The round trip: the assistant's call and its result, as OpenCode sends them next.
  const second = await proxyChat(deps(), identity(run), {
    messages: [
      { role: "user", content: "find x" },
      {
        role: "assistant",
        content: "Let me look",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "x is here" },
    ],
  });
  if (second.kind !== "json") throw new Error("expected json");
  expect(second.body).toMatchObject({ choices: [{ message: { content: "Found it" }, finish_reason: "stop" }] });
  expect(f.provider.calls[1]?.request.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "find x" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look" },
        { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "x is here" }] },
  ]);
  // Two calls, two usage rows: the gateway records each, nothing else does.
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(2);
});

test("an exhausted budget answers 402 before any provider call, streamed or not", async () => {
  f = await setup({ budgetNanoUsd: 0 });
  const run = await runRow();
  for (const stream of [false, true]) {
    const reply = await proxyChat(deps(), identity(run), { stream, messages: [{ role: "user", content: "hi" }] });
    if (reply.kind !== "json") throw new Error("expected an HTTP error");
    expect(reply.status).toBe(402);
    expect(reply.body).toMatchObject({ error: { type: "insufficient_quota", code: "budget_exceeded" } });
  }
  expect(f.provider.calls).toHaveLength(0);
  expect(proxyModels().data[0]?.id).toBe("agent");
});

test("the bearer is the turn's run token: a run's, alive while it goes on, bound to no socket", async () => {
  f = await setup();
  const run = await runRow();
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Box",
    ...RUNNER,
    exec: true,
  });
  const token = await issueRunToolToken(f.db, { orgId: f.org.id, agentId: f.agent.id, machineId, runId: run.id });
  expect(await verifyRunToolTokenForProxy(f.db, token)).toMatchObject({
    ok: true,
    identity: { orgId: f.org.id, agentId: f.agent.id, runId: run.id },
  });
  expect(await verifyRunToolTokenForProxy(f.db, "nonsense")).toMatchObject({ ok: false });
  expect(await verifyRunToolTokenForProxy(f.db, token.slice(0, -2))).toMatchObject({ ok: false });
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  expect(await verifyRunToolTokenForProxy(f.db, token)).toMatchObject({ ok: false, error: { code: "bridge.run_ended" } });
});

const online = (id: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id,
  orgId: "org",
  name: "Box",
  online: true,
  execAllowed: true,
  os: "linux",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { opencode: { version: "2.3.2" }, detectedAt: new Date().toISOString() },
  ...over,
});

test("an API-key agent thinks through OpenCode when its computer can, else in the server's process", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Box",
    ...RUNNER,
    exec: true,
  });
  const machineId = paired.machineId;
  await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, f.agent.id));
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("no agent");
  const run = await runRow();
  const plan = (status: MachineStatus | null, options = {}) =>
    resolveBrain({ db: f.db, machines: { status: async () => status } }, agent, run, f.general.id, options);

  const proxied = await plan(online(machineId));
  expect(proxied).toMatchObject({ kind: "opencode", proxy: true, model: MODEL_PROXY_MODEL });
  expect(proxied.account).toBeUndefined();
  expect(proxied.session?.machineId).toBe(machineId);
  expect(proxied.unavailable).toBeUndefined();

  // A runner before the proxy, offline, paused, no OpenCode, its tool off, or a thread that must stay here: the model.
  expect((await plan(online(machineId, { protocol: MODEL_PROXY_PROTOCOL - 1 }))).kind).toBe("model");
  expect((await plan(online(machineId, { online: false }))).kind).toBe("model");
  expect((await plan(online(machineId, { paused: { until: null, timezone: null } }))).kind).toBe("model");
  expect((await plan(online(machineId, { executors: { detectedAt: new Date().toISOString() } }))).kind).toBe("model");
  expect((await plan(online(machineId, { access: { tools: { opencode: false } } as MachineStatus["access"] }))).kind).toBe(
    "model",
  );
  expect((await plan(null)).kind).toBe("model");
  expect((await plan(online(machineId), { noProxy: true })).kind).toBe("model");
  // No computer is wired at all (a test or a server without them): the model.
  expect((await resolveBrain({ db: f.db }, agent, run, f.general.id)).kind).toBe("model");
});

test("an agent with no computer of its own uses no person's: none paired by someone is ever picked", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "Mac",
    ...RUNNER,
    exec: true,
  });
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("no agent");
  const run = await runRow();
  const asked: string[] = [];
  const plan = await resolveBrain(
    {
      db: f.db,
      machines: {
        status: async (id) => {
          asked.push(id);
          return online(id);
        },
      },
    },
    agent,
    run,
    f.general.id,
  );
  expect(plan.kind).toBe("model");
  expect(asked).not.toContain(paired.machineId);
});
