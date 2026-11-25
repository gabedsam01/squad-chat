import { compareInOrder } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type {
  AccountUseReason,
  AgentBrainInput,
  AgentSetup,
  AiHub,
  AiHubAccount,
  AiHubKey,
  BrainEffortSetting,
  BrainKind,
  BrainOption,
  BrainScope,
  Model,
  ModelTier,
} from "../api/types";
import { ACCOUNT_KINDS, accountTitle, orderAccounts } from "./ai-accounts";
import { EFFORT_LEVELS, type EffortLevel, effortLevelsOf } from "./brain-advanced";
import { type ModelRow, modelRows } from "./brain-picker";
import { firstName } from "./format";
import { type BrainModelFamily, brainModelChoices, familyOfModel, isPlanId, planOf } from "./plans";
import { AUTO, isAuto } from "./providers";

/*
 * The one "account + model + effort" choice (web and phone): which AI a target thinks with, built from "Contas de IA"
 * (`AiHub`) for every picker, so the rows, their order and why one can't be used are worked out once.
 */

/** What is being chosen for. */
export type AiChoiceTarget =
  | { kind: "agent"; agentId: string }
  /** Lodi: the viewer's own AI (`mine`, "A do workspace" first) or the workspace's (admins). */
  | { kind: "lodi"; agentId: string; scope: BrainScope }
  /** An agent still being created: the choice is the caller's to apply once it exists. */
  | { kind: "newAgent" }
  | { kind: "mission"; missionId: string }
  /** "Usar em outros agentes": one setup on several agents. */
  | { kind: "agents"; agentIds: readonly string[] }
  /** "Automático" on a provider's key: the model of one tier. */
  | { kind: "autoTier"; provider: string; tier: ModelTier };

/** A choice: what to think with, its model and effort. */
export interface AiChoice {
  brain: BrainKind;
  /** A plan's account; null: the computer's own sign-in. */
  account?: string | null;
  /** The API's key; null: the workspace's default. */
  key?: string | null;
  /** Where a plan thinks (its account's computer). */
  machineId?: string | null;
  /** null: the brain's default. */
  model?: string | null;
  effort?: BrainEffortSetting | null;
  /** The person's own AI on Lodi only (ADR 9002): 200K, 400K or 1M; null: the model's window. */
  contextTokens?: number | null;
}

/** The picker's sections, in order: Lodi's "A do workspace", the viewer's accounts, others' accounts, API keys. */
export type AiChoiceGroup = "workspace" | "yours" | "others" | "keys";
export const AI_CHOICE_GROUPS: readonly AiChoiceGroup[] = ["workspace", "yours", "others", "keys"];

/** One option of the "Conta" select. */
export interface AiChoiceRow {
  /** Stable: the account's id (its first login's), `key:` and the key's id, a brain kind (a mission), or `workspace`. */
  key: string;
  type: "plan" | "key" | "brain" | "workspace";
  group: AiChoiceGroup;
  brain: BrainKind;
  account?: AiHubAccount;
  apiKey?: AiHubKey;
  /** Picking it works; else it shows dimmed with `reason`. */
  usable: boolean;
  reason?: AccountUseReason;
  selected: boolean;
}

export interface AiChoiceContext {
  target: AiChoiceTarget;
  viewerId: string;
  current: AiChoice | null;
  /** Only the accounts on this computer (an agent's: a plan thinks where its account is signed in). */
  machineId?: string | null;
  /** The accounts that may think for the target as the server says (an agent's "Quem pensa", `usable`). */
  usable?: ReadonlySet<string>;
  /** The workspace's default key (`defaultCredentialId`): what an agent with no key of its own thinks with. */
  defaultKeyId?: string | null;
  /** A mission's brains (it picks a brain and a model, never an account). */
  brains?: readonly BrainOption[];
}

const kindRank = (kind: string) => {
  const i = (ACCOUNT_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? ACCOUNT_KINDS.length : i;
};

/**
 * Every account's logins (`sameAs`), by maker, then in the one order of use with `viewerId`'s own first: the order of
 * the picker's rows and of "Contas de IA".
 */
export function hubAccountsInOrder<A extends AiHubAccount>(accounts: readonly A[], viewerId: string): A[][] {
  const inOrder = compareInOrder(viewerId);
  const first = (logins: readonly A[]) => logins[0] as A;
  return orderAccounts(accounts).sort(
    (x, y) => kindRank(first(x).kind) - kindRank(first(y).kind) || inOrder(first(x), first(y)),
  );
}

/** The key a null `key` means: the workspace default when known (`defaultKeyId`), else the provider-level flag. */
const isWorkspaceDefault = (k: AiHubKey, ctx: AiChoiceContext) =>
  ctx.defaultKeyId ? k.id === ctx.defaultKeyId : k.isDefault;

/** The target thinks with keys too: not Lodi's own AI (its "A do workspace" is the workspace's key). */
const takesKeys = (t: AiChoiceTarget) => t.kind !== "mission" && !(t.kind === "lodi" && t.scope === "mine");

/** Why an account can't think for the target, or null when it can. */
function blocked(a: AiHubAccount, ctx: AiChoiceContext): AccountUseReason | null {
  if (a.status !== "active") return "signed_out";
  if (ctx.usable) return ctx.usable.has(a.id) ? null : (a.rights.useReason ?? "not_allowed");
  if (ctx.target.kind === "lodi" && ctx.target.scope === "workspace")
    return a.permissions.use.mode === "everyone" ? null : (a.rights.useReason ?? "not_allowed");
  return a.rights.canUse ? null : (a.rights.useReason ?? "not_allowed");
}

/**
 * The rows of the "Conta" select for a target, in the picker's order: Lodi's "A do workspace" first, then the viewer's
 * own accounts, others' accounts, then the API keys. Accounts by maker, then in the order of use (`compareInOrder`, the
 * viewer's own first); the logins of one account (`sameAs`) are one row. Accounts the target can't think with stay,
 * dimmed, with why. `autoTier`: that provider's keys only.
 */
export function aiChoiceRows(hub: AiHub | null | undefined, ctx: AiChoiceContext): AiChoiceRow[] {
  const { target, current } = ctx;
  const rows: AiChoiceRow[] = [];
  if (target.kind === "mission") {
    for (const o of ctx.brains ?? []) {
      rows.push({
        key: o.kind,
        type: "brain",
        group: o.kind === "model" ? "keys" : "yours",
        brain: o.kind,
        usable: o.available,
        selected: current?.brain === o.kind,
      });
    }
    return rows;
  }
  if (target.kind === "lodi" && target.scope === "mine") {
    rows.push({
      key: "workspace",
      type: "workspace",
      group: "workspace",
      brain: "model",
      usable: true,
      selected: !current || current.brain === "model",
    });
  }
  if (target.kind !== "autoTier" && hub) {
    const accounts = hub.accounts.filter((a) => !ctx.machineId || a.machineId === ctx.machineId);
    const firsts = hubAccountsInOrder(accounts, ctx.viewerId).map((logins) => ({
      logins,
      first: logins.find((l) => l.id === current?.account) ?? (logins[0] as AiHubAccount),
    }));
    for (const { logins, first } of firsts) {
      const why = blocked(first, ctx);
      rows.push({
        key: first.id,
        type: "plan",
        group: first.mine ? "yours" : "others",
        brain: first.kind,
        account: first,
        usable: why === null,
        ...(why ? { reason: why } : {}),
        selected: !!current?.account && logins.some((l) => l.id === current.account),
      });
    }
  }
  // A plan through its computer's own sign-in (no account row): the choice in use stays a row of its own.
  const own = (target.kind === "agent" || target.kind === "lodi") && current && current.brain !== "model";
  if (own && !current.account && !rows.some((r) => r.selected))
    rows.unshift({
      key: `own:${current.brain}`,
      type: "brain",
      group: "yours",
      brain: current.brain,
      usable: true,
      selected: true,
    });
  if (takesKeys(target) && hub) {
    const keys = target.kind === "autoTier" ? hub.keys.filter((k) => k.provider === target.provider) : hub.keys;
    for (const k of keys) {
      rows.push({
        key: `key:${k.id}`,
        type: "key",
        group: "keys",
        brain: "model",
        apiKey: k,
        usable: true,
        selected: current?.brain === "model" && (current.key ? current.key === k.id : isWorkspaceDefault(k, ctx)),
      });
    }
  }
  return AI_CHOICE_GROUPS.flatMap((g) => rows.filter((r) => r.group === g));
}

/**
 * The "Modelo" select for a row: a plan's models from its computer's brain options (`options`, Automático first), an
 * API key's from the catalog for its provider (its endpoint's own for a workspace endpoint), the chosen one checked.
 */
export function aiChoiceModels(
  t: TFunction,
  row: AiChoiceRow,
  ctx: {
    current: AiChoice | null;
    options: readonly BrainOption[];
    models: readonly Model[];
    /** The ids the workspace's OpenRouter keys chose (`Credential.openrouter.models`). */
    chosen?: ReadonlySet<string>;
  },
): ModelRow[] {
  if (row.type === "workspace") return [];
  const same = ctx.current?.brain === row.brain && (row.type !== "plan" || row.selected);
  if (row.type === "key") {
    const k = row.apiKey;
    const chosen = same ? (ctx.current?.model ?? AUTO) : AUTO;
    // The workspace's own OpenRouter choice (ADR 9005) joins the picks, without repeats.
    const list = ctx.models.filter((m) =>
      k?.endpoint
        ? m.endpoint?.credentialId === k.id
        : m.provider === k?.provider && (m.pick !== false || (ctx.chosen?.has(m.id) ?? false)),
    );
    return [
      { value: AUTO, label: t("brain.auto.label"), sub: t("brain.auto.hint"), checked: isAuto(chosen) },
      ...list.map((m) => ({ value: m.id, label: m.label, checked: m.id === chosen })),
    ];
  }
  return modelRows(
    t,
    {
      brain: row.brain,
      effectiveModel: same ? (ctx.current?.model ?? null) : null,
      options: [...ctx.options],
      account: row.account?.id ?? null,
      accounts: row.account ? [row.account] : [],
    },
    planOf(row.account?.provider ?? undefined),
  );
}

/** The model a plan sells at thinking levels (Antigravity), when `model` is one of its level ids; undefined for any other. */
export const effortFamilyOf = (
  options: readonly BrainOption[],
  kind: BrainKind,
  model: string | null | undefined,
): BrainModelFamily | undefined =>
  familyOfModel(brainModelChoices(undefined, options.find((o) => o.kind === kind)?.models ?? []), model);

/** The "Esforço" select for a row: the plan's levels or the API's; none for Lodi's "A do workspace". */
export const aiChoiceEfforts = (row: AiChoiceRow): readonly EffortLevel[] =>
  row.type === "workspace" ? [] : effortLevelsOf(row.brain);

/** The choice a row makes, keeping the model and effort when the brain stays. */
export function aiChoiceOf(row: AiChoiceRow, current: AiChoice | null): AiChoice {
  // Lodi's "A do workspace": the workspace's own AI, nothing of the person's to carry.
  if (row.type === "workspace") return { brain: "model" };
  // A key's model belongs to that key: another key starts on Automático, never carrying the old one's.
  const keep = current?.brain === row.brain && (row.type !== "key" || row.selected);
  const fresh = row.type === "key" ? AUTO : null;
  const rest: Pick<AiChoice, "model" | "effort" | "contextTokens"> = keep
    ? {
        model: current?.model ?? null,
        effort: current?.effort ?? null,
        ...(current?.contextTokens !== undefined ? { contextTokens: current.contextTokens } : {}),
      }
    : { model: fresh, effort: fresh, ...(current?.contextTokens !== undefined ? { contextTokens: null } : {}) };
  if (row.type === "plan" && row.account)
    return { brain: row.brain, account: row.account.id, machineId: row.account.machineId, ...rest };
  if (row.type === "key")
    // Always the key's own id: `isDefault` is per provider, and null would land on the workspace default's provider.
    return { brain: "model", key: row.apiKey?.id ?? null, ...rest };
  return { brain: row.brain, ...rest };
}

/** What an agent's or Lodi's "Quem pensa" saves for a choice (`PUT …/agents/{id}/brain`). */
export function aiChoiceBrainInput(choice: AiChoice, scope?: BrainScope): AgentBrainInput {
  return {
    ...(scope ? { scope } : {}),
    brain: choice.brain,
    ...(choice.brain !== "model" ? { account: choice.account ?? null } : {}),
    ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
    ...(choice.contextTokens !== undefined ? { contextTokens: choice.contextTokens } : {}),
  };
}

/** The setup "Usar em outros agentes" applies for a choice (`POST …/agent-setup`). */
export function aiChoiceSetup(choice: AiChoice): AgentSetup {
  return {
    brain: choice.brain,
    model: choice.model ?? null,
    ...(choice.brain === "model"
      ? { key: choice.key ?? null }
      : { machineId: choice.machineId ?? null, account: choice.account ?? null }),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
  };
}

/**
 * An account's name where its plan shows beside it ("Trabalho", then "Max · de João"): someone else's and a key
 * account by their name alone, the viewer's own as every app titles it (`accountTitle`).
 */
export const accountShortName = (
  t: TFunction,
  a: Pick<AiHubAccount, "label" | "plan" | "email" | "mine" | "named" | "keyHint" | "provider">,
) => (!a.mine || a.keyHint != null || isPlanId(a.provider) ? a.label : accountTitle(t, a));

/** Why a row is dimmed, in words: its owner by name. */
export const reasonText = (t: TFunction, row: Pick<AiChoiceRow, "reason" | "account">) =>
  row.reason ? t(`aiAccounts.useReason.${row.reason}`, { owner: firstName(row.account?.ownerName ?? "") }) : "";

/** Where a fixed model starts after Automático: Médio if its scale has it, else the closest level it has, else none. */
export function startLevel(scale: readonly string[] | null | undefined): EffortLevel | null {
  const at = (l: string) => EFFORT_LEVELS.indexOf(l as EffortLevel);
  const have = EFFORT_LEVELS.filter((l) => scale?.includes(l));
  const mid = at("medium");
  return have.reduce<EffortLevel | null>(
    (best, l) => (best === null || Math.abs(at(l) - mid) < Math.abs(at(best) - mid) ? l : best),
    null,
  );
}
