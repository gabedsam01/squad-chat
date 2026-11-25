import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { currentOf } from "../src/api/ai-hub";
import type { AccountAudience, AiHub, AiHubAccount, AiHubKey, BrainOption, Model } from "../src/api/types";
import { accountChain } from "../src/lib/ai-accounts";
import {
  type AiChoiceContext,
  aiChoiceBrainInput,
  aiChoiceEfforts,
  aiChoiceModels,
  aiChoiceOf,
  aiChoiceRows,
  aiChoiceSetup,
  effortFamilyOf,
  startLevel,
} from "../src/lib/ai-choice";

const t = ((key: string) => key) as TFunction;
const all: AccountAudience = { mode: "everyone", userIds: [], roleIds: [] };
const only: AccountAudience = { mode: "owner", userIds: [], roleIds: [] };

const account = (id: string, over: Partial<AiHubAccount> = {}): AiHubAccount => ({
  id,
  kind: "claude_code",
  label: `Conta ${id}`,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u_walter",
  ownerName: "Walter",
  mine: false,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  useOrder: null,
  sameAs: id,
  movable: true,
  machineId: "m1",
  computer: "MacBook",
  permissions: { manage: { mode: "admins", userIds: [], roleIds: [] }, use: all, reply: only },
  rights: { canManage: false, canSetManage: false, canUse: true, canReplyAll: false },
  ...over,
});

const key = (id: string, over: Partial<AiHubKey> = {}): AiHubKey => ({
  id,
  provider: "anthropic",
  label: `Chave ${id}`,
  keyHint: "AbCd",
  isDefault: false,
  ...over,
});

const hub = (accounts: AiHubAccount[], keys: AiHubKey[] = []): AiHub => ({
  accounts,
  keys,
  order: [],
  keyFallback: false,
  canManageKeys: false,
  canConfigure: false,
});

const ctx = (over: Partial<AiChoiceContext> = {}): AiChoiceContext => ({
  target: { kind: "agent", agentId: "a1" },
  viewerId: "u_ana",
  current: null,
  ...over,
});

describe("aiChoiceRows: one list for every picker", () => {
  test("the viewer's own first, then others', then keys; by maker, then the order of use", () => {
    const h = hub(
      [
        account("w1", { useOrder: 1 }),
        account("x1", { kind: "codex" }),
        account("w0", { useOrder: 0 }),
        account("a1", { ownerId: "u_ana", ownerName: "Ana", mine: true }),
      ],
      [key("k1", { isDefault: true }), key("k2", { provider: "openai" })],
    );
    const rows = aiChoiceRows(h, ctx());
    expect(rows.map((r) => [r.key, r.group])).toEqual([
      ["a1", "yours"],
      ["w0", "others"],
      ["w1", "others"],
      ["x1", "others"],
      ["key:k1", "keys"],
      ["key:k2", "keys"],
    ]);
  });

  test("an agent's computer only, and the server's word on what may think for it; unusable rows stay, dimmed with why", () => {
    const h = hub([
      account("w1"),
      account("w2", {
        rights: { canManage: false, canSetManage: false, canUse: false, useReason: "owner_only", canReplyAll: false },
      }),
      account("gone", { status: "signed_out" }),
      account("far", { machineId: "m2" }),
    ]);
    const rows = aiChoiceRows(h, ctx({ machineId: "m1", usable: new Set(["w1"]) }));
    expect(rows.map((r) => [r.key, r.usable, r.reason ?? null])).toEqual([
      ["w1", true, null],
      ["w2", false, "owner_only"],
      ["gone", false, "signed_out"],
    ]);
  });

  test("the logins of one account are one row, the one thinking selected", () => {
    const h = hub([account("l1", { sameAs: "l1" }), account("l2", { sameAs: "l1" })]);
    const rows = aiChoiceRows(h, ctx({ current: { brain: "claude_code", account: "l2" } }));
    expect(rows.map((r) => [r.key, r.selected])).toEqual([["l2", true]]);
  });

  test("Lodi: A do workspace first for the viewer's own, no keys there; the workspace's takes only accounts everyone uses", () => {
    const h = hub(
      [account("w1"), account("w2", { permissions: { manage: only, use: only, reply: only } })],
      [key("k1")],
    );
    const mine = aiChoiceRows(h, ctx({ target: { kind: "lodi", agentId: "l", scope: "mine" } }));
    expect(mine.map((r) => [r.key, r.selected])).toEqual([
      ["workspace", true],
      ["w1", false],
      ["w2", false],
    ]);
    const workspace = aiChoiceRows(h, ctx({ target: { kind: "lodi", agentId: "l", scope: "workspace" } }));
    expect(workspace.map((r) => [r.key, r.usable])).toEqual([
      ["w1", true],
      ["w2", false],
      ["key:k1", true],
    ]);
  });

  test("a mission picks a brain; an Automático tier its provider's keys", () => {
    const options: BrainOption[] = [
      { kind: "claude_code", available: true, models: [], defaultModel: null },
      { kind: "model", available: false, models: [], defaultModel: null },
    ];
    const mission = aiChoiceRows(hub([account("w1")]), {
      ...ctx({ target: { kind: "mission", missionId: "m" }, current: { brain: "claude_code" } }),
      brains: options,
    });
    expect(mission.map((r) => [r.key, r.type, r.usable, r.selected])).toEqual([
      ["claude_code", "brain", true, true],
      ["model", "brain", false, false],
    ]);
    const tier = aiChoiceRows(hub([account("w1")], [key("k1"), key("or", { provider: "openrouter" })]), {
      ...ctx({ target: { kind: "autoTier", provider: "openrouter", tier: "small" } }),
    });
    expect(tier.map((r) => r.key)).toEqual(["key:or"]);
  });

  test("an older server without the hub: no rows, nothing breaks", () => {
    expect(aiChoiceRows(null, ctx())).toEqual([]);
  });
});

describe("what a row chooses and saves", () => {
  test("the model and effort stay while the brain stays; a key by its id, the default as null", () => {
    const [plan, def, other] = aiChoiceRows(hub([account("w1")], [key("k1", { isDefault: true }), key("k2")]), ctx());
    if (!plan || !def || !other) throw new Error("rows");
    const current = { brain: "claude_code" as const, account: "w0", model: "opus", effort: "high" as const };
    expect(aiChoiceOf(plan, current)).toEqual({
      brain: "claude_code",
      account: "w1",
      machineId: "m1",
      model: "opus",
      effort: "high",
    });
    expect(aiChoiceOf(def, current)).toEqual({ brain: "model", key: "k1", model: "auto", effort: "auto" });
    expect(aiChoiceOf(other, null)).toMatchObject({ brain: "model", key: "k2" });
    expect(aiChoiceBrainInput(aiChoiceOf(plan, current), "mine")).toEqual({
      scope: "mine",
      brain: "claude_code",
      account: "w1",
      model: "opus",
      effort: "high",
    });
    expect(aiChoiceSetup(aiChoiceOf(other, null))).toEqual({
      brain: "model",
      model: "auto",
      key: "k2",
      effort: "auto",
    });
    expect(aiChoiceSetup(aiChoiceOf(plan, current))).toMatchObject({ machineId: "m1", account: "w1" });
  });

  test("a provider's default key that is not the workspace default is picked by its own id", () => {
    const keys = [
      key("or", { provider: "openrouter", isDefault: true }),
      key("lite", { provider: "custom", isDefault: true }),
    ];
    const rows = aiChoiceRows(hub([], keys), ctx({ defaultKeyId: "or", current: { brain: "model", key: null } }));
    const lite = rows.find((r) => r.key === "key:lite");
    if (!lite) throw new Error("rows");
    expect(aiChoiceOf(lite, null)).toMatchObject({ brain: "model", key: "lite" });
    // An agent with no key of its own follows the workspace default: only that row reads selected.
    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["key:or"]);
  });

  test("another key starts on Automático, never carrying the old key's model; the same key keeps it", () => {
    const rows = aiChoiceRows(hub([], [key("k1", { isDefault: true }), key("k2")]), ctx());
    const [k1, k2] = rows;
    if (!k1 || !k2) throw new Error("rows");
    const current = { brain: "model" as const, key: "k2", model: "custom:x:river", effort: "high" as const };
    const sel = aiChoiceRows(hub([], [key("k1", { isDefault: true }), key("k2")]), ctx({ current }));
    expect(aiChoiceOf(k1, current)).toMatchObject({ key: "k1", model: "auto", effort: "auto" });
    expect(aiChoiceOf(sel.find((r) => r.key === "key:k2") as never, current)).toMatchObject({
      key: "k2",
      model: "custom:x:river",
      effort: "high",
    });
    // from a subscription account to a key
    const fromPlan = { brain: "opencode" as const, account: "w0", model: "m", effort: "low" as const };
    expect(aiChoiceOf(k2, fromPlan)).toMatchObject({ brain: "model", key: "k2", model: "auto" });
  });

  test("an OpenRouter key lists the workspace's chosen models beside the picks, once each", () => {
    const [k] = aiChoiceRows(hub([], [key("or", { provider: "openrouter" })]), ctx());
    if (!k) throw new Error("row");
    const m = (id: string, pick?: boolean): Model => ({
      id,
      label: id,
      provider: "openrouter",
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 1,
      ...(pick === undefined ? {} : { pick }),
    });
    const models = [m("alias", true), m("xiaomi/mimo", false), m("other/x", false)];
    const rows = aiChoiceModels(t, k, {
      current: null,
      options: [],
      models,
      chosen: new Set(["xiaomi/mimo", "alias"]),
    });
    expect(rows.map((r) => r.value)).toEqual(["auto", "alias", "xiaomi/mimo"]);
  });

  test("a fixed model after Automático starts on Médio, else the closest level it has", () => {
    expect(startLevel(["low", "medium", "high"])).toBe("medium");
    expect(startLevel(["low", "high", "max"])).toBe("low");
    expect(startLevel(["high", "xhigh"])).toBe("high");
    expect(startLevel([])).toBeNull();
    expect(startLevel(null)).toBeNull();
  });

  test("models: a key's from its provider's catalog with Automático first; efforts by brain", () => {
    const [k] = aiChoiceRows(hub([], [key("k1")]), ctx());
    if (!k) throw new Error("row");
    const models: Model[] = [
      { id: "claude-a", label: "Claude A", provider: "anthropic", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
      { id: "gpt-b", label: "GPT B", provider: "openai", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    ];
    const rows = aiChoiceModels(t, k, { current: { brain: "model", model: "claude-a" }, options: [], models });
    expect(rows.map((r) => [r.value, r.checked])).toEqual([
      ["auto", false],
      ["claude-a", true],
    ]);
    expect(aiChoiceEfforts(k)).toEqual(["low", "medium", "high"]);
  });

  test("the current choice as each target's own view says it", () => {
    expect(
      currentOf(
        { kind: "agent", agentId: "a" },
        {
          brain: { brain: "claude_code", account: "w1", model: null, effort: "auto", computer: { machineId: "m1" } },
        },
      ),
    ).toEqual({ brain: "claude_code", account: "w1", machineId: "m1", model: null, effort: "auto" });
    expect(
      currentOf(
        { kind: "autoTier", provider: "openrouter", tier: "large" },
        { autoModels: { openrouter: { large: "x/y" } } },
      ),
    ).toEqual({ brain: "model", model: "x/y" });
    expect(currentOf({ kind: "agents", agentIds: ["a"] }, {})).toBeNull();
  });

  test("an agent on a non-default key: its key's row is the selected one and its model the checked one", () => {
    const models: Model[] = [
      { id: "claude-a", label: "Claude A", provider: "anthropic", inputUsdPerMTok: 1, outputUsdPerMTok: 1 },
    ];
    const current = currentOf(
      { kind: "agent", agentId: "a" },
      { brain: { brain: "model", account: null, model: "claude-a", key: "k2", effort: null, computer: null } },
    );
    expect(current).toMatchObject({ brain: "model", key: "k2", model: "claude-a" });
    const rows = aiChoiceRows(hub([], [key("k1", { isDefault: true }), key("k2")]), ctx({ current }));
    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["key:k2"]);
    const row = rows.find((r) => r.key === "key:k2");
    if (!row) throw new Error("row");
    expect(aiChoiceModels(t, row, { current, options: [], models }).find((m) => m.checked)?.value).toBe("claude-a");
  });
});

describe("accountChain follows the one order and the server's word", () => {
  test("its owner's first, then by place; an account that can't serve the agent's owner is skipped", () => {
    const own = account("own", { ownerId: "u_ana", mine: true });
    const chain = accountChain(
      [
        own,
        account("w1", { useOrder: 1 }),
        account("w0", { useOrder: 0 }),
        account("no", { usable: false }),
        account("a2", { ownerId: "u_ana" }),
      ],
      { id: "agent", ownerId: "u_ana", account: "own" },
    );
    expect(chain.map((a) => a.id)).toEqual(["own", "a2", "w0", "w1"]);
  });
});

test("a model sold at thinking levels runs a level by its own id (Antigravity)", () => {
  const options = [
    {
      kind: "antigravity",
      available: true,
      defaultModel: null,
      models: [
        { value: "argon-low", label: "Argon", family: { id: "argon", label: "Argon" }, level: "low" },
        { value: "argon-high", label: "Argon", family: { id: "argon", label: "Argon" }, level: "high" },
      ],
    },
  ] as unknown as BrainOption[];
  const family = effortFamilyOf(options, "antigravity", "argon-low");
  expect(family?.levels).toEqual(["low", "high"]);
  expect(family?.values.high).toBe("argon-high");
  expect(effortFamilyOf(options, "claude_code", "argon-low")).toBeUndefined();
});
