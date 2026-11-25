import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type {
  AgentScope,
  BrainColdCause,
  BrainSteerReply,
  BrainTurnTimings,
  BrainWarmReply,
  BrainWarmRequest,
} from "@agenteschat/adapters/machine-protocol";
import { isAccountId, MODEL_PROXY_MODEL } from "@agenteschat/adapters/machine-protocol";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { type PlanId, planOf } from "@agenteschat/providers/plans";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSignIn,
  opencodeKeyOf,
  planKeyOf,
  withoutSignIns,
} from "./accounts";
import { ACP_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION, AcpConnection, AcpError } from "./acp";
import { awakeClock } from "./awake";
import {
  CODEX_TOOL_OUTPUT_MAX,
  type CodexBrainEvent,
  CodexThreads,
  codexProfileOf,
  codexThreadKey,
} from "./brain-codex";
import { CODEX_APP_IDLE_MS, CODEX_APP_MAX_PROCESSES } from "./brain-codex-app";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { cliSpawn, envValue, OPENCODE_BIN } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, type McpTaskInfo, newMcpToken, redactDeep } from "./mcp";
import { ProxyRelay } from "./model-proxy-relay";
import { isInside, resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The OpenCode branch of `brain.turn` (protocol 39, ADR 0132; over the Agent Client Protocol since protocol 64): one
 * agent turn as one `opencode acp` process, driven through `acp.ts`. OpenCode 1.x and 2.x both serve it (read in
 * their sources at 1.19.5 and 2.2.7, `packages/opencode/src/acp` and `packages/cli/src/acp`, and run against both,
 * 2026-11-13); 2.x always runs it on a private server of its own, never on the person's background service.
 *
 * - The session: our session → OpenCode's lives in `<runner home>/brain/opencode-sessions.json`, per account and
 *   folder. A stored one is resumed (`session/resume`, no history replayed); one OpenCode no longer has answers with
 *   an error, and a new session starts with the engine's context leading its first prompt (ACP has no system prompt).
 *   Nothing is created silently in its place, so the context is never lost.
 * - The model: `session/set_config_option` (`model`), the protocol's own way that both versions list; the config
 *   names it too, so a new session starts with it.
 * - Our MCP server goes with each session (`mcpServers`): stdio `agentes-runner mcp --run <run>` with the token, socket
 *   and home in its env, or the bridge's URL with the token as a bearer.
 * - Everything else rides on `OPENCODE_CONFIG_CONTENT`: the permissions (ADR 0053 §3), no sharing, no self-update, the
 *   account's key, the free tier's one provider. OpenCode merges it over the other configs it reads and joins their
 *   plugin lists, so it removes nothing they add: those configs are kept empty instead. `OPENCODE_DISABLE_PROJECT_CONFIG`:
 *   no project `opencode.json` or `.opencode/`. Its global config folder (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`) is
 *   `<runner home>/brain/opencode-config`, emptied of everything but OpenCode's own packages before each turn. A
 *   `~/.opencode` with settings, plugins, agents, modes or tools refuses the turn (OpenCode always reads it, and only a
 *   person should remove it). `OPENCODE_PERMISSION`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` aren't inherited.
 * - Permissions never ask: every rule allows or denies, since OpenCode 2.x ends the whole turn when a request is
 *   refused over ACP. One that asks anyway (a rule a computer's managed config adds) is refused, and the turn says so.
 *   `execute` is denied so our bridge's tools are called by name, not through OpenCode 2's code mode.
 * - The free tier (`freeTier`: no account, a computer nobody connected): no stray key in the env and
 *   `enabled_providers: ["opencode"]`, so no key the runner or the computer holds thinks for anyone's agent.
 * - Events: `agent_message_chunk` streams the text; a tool call of OpenCode's own, once it ended, is an executed
 *   `tool_call` (transcript only; our bridge's are left out: the engine ran them); the prompt's answer carries the
 *   tokens. A `chat` turn stops at the first tool call that isn't our bridge's, before OpenCode runs it.
 * - Live steering (OpenCode 2.x, `_session/steering`): `brain.steer` hands messages to the turn, read at its next model
 *   step (`steer_read`). 1.x takes nothing mid-turn (`unsupported`).
 * - Silence: OpenCode 1.x waits out a provider's limit by itself (a `retry-after` of hours) and says nothing over ACP;
 *   a turn that hears nothing for `OPENCODE_SILENCE_MS` with no tool running stops and says why.
 * - Windows: the CLI starts by its full path, npm's launcher skipped for the binary it runs (`cliSpawn`), in no new
 *   console; stopping it takes its whole tree (`killTree`).
 * - ADR 0041/0059: a turn with an `account` runs with that account's folder as OpenCode's XDG folders (`accountEnv`)
 *   and its sealed key as the `opencode` provider's key. Without one, the computer's own OpenCode: its own sign-ins, or
 *   the free tier with none. Usage is the person's (`source: "plan"`, cost zero for us).
 */

/** After asking OpenCode to stop, how long the turn waits for it before the process is killed. */
const STOP_WAIT_MS = 8000;
/** After the turn, how long the process may take to exit by itself (its input closed) before it is killed. */
const EXIT_GRACE_MS = 3000;
/** How long a process told to end (SIGTERM, then SIGKILL) has to go before the turn stops waiting for it. */
const KILL_WAIT_MS = 2000;
/** How long each step of starting (initialize, the session, the model) may take. */
const SETUP_TIMEOUT_MS = 120_000;
/** A turn that hears nothing from OpenCode this long, with no tool running, stops (see the header). */
export const OPENCODE_SILENCE_MS = 5 * 60_000;

/** `brain.turn` with `kind: "opencode"`. */
export interface OpencodeBrainTurnRequest {
  runId: string;
  kind: "opencode";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
  /** No account on a computer nobody connected: OpenCode's own free tier and nothing else (ADR 0132). */
  freeTier?: boolean;
  /** The turn thinks through the server's model proxy (ADR 9007); `mcp.token` is its bearer. */
  proxy?: true;
}

/** Where our session → OpenCode session ids live in the runner home. */
export const opencodeSessionsFile = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-sessions.json");

/** OpenCode's global config folder for our turns: emptied before each one but for `OPENCODE_CONFIG_KEPT`. */
export const opencodeConfigDir = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-config");

/** What OpenCode keeps in its config folder itself (`@opencode-ai/plugin` installed with bun): kept between turns. */
const OPENCODE_CONFIG_KEPT = new Set(["node_modules", "package.json", "bun.lock", ".gitignore"]);

/** What OpenCode reads from `~/.opencode` on every run: settings, plugins, agents, modes, tools. */
export const OPENCODE_HOME_LOADED = [
  "opencode.json",
  "opencode.jsonc",
  "plugin",
  "plugins",
  "agent",
  "agents",
  "mode",
  "modes",
  "tool",
  "tools",
] as const;

/** Empties (or makes) the config folder, keeping only `OPENCODE_CONFIG_KEPT`. */
export function resetOpencodeConfig(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (!OPENCODE_CONFIG_KEPT.has(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** What of `OPENCODE_HOME_LOADED` is in `<home>/.opencode`. */
export const opencodeHomePlanted = (home: string) =>
  OPENCODE_HOME_LOADED.filter((name) => existsSync(path.join(home, ".opencode", name)));

/** The env name an account's key reaches the `opencode` provider through. */
export const OPENCODE_KEY_ENV = "OPENCODE_API_KEY";

/** The server's model proxy as an OpenCode provider (ADR 9007), and the env name its bearer reaches it through. */
export const PROXY_PROVIDER = "squadchat";
export const PROXY_MODEL = MODEL_PROXY_MODEL;
export const PROXY_KEY_ENV = "SQUADCHAT_PROXY_KEY";

/** Our bridge's tools as OpenCode names them (`<server>_<tool>`). */
const BRIDGE_PREFIX = `${CODEX_MCP_SERVER}_`;

/**
 * OpenCode's permissions for a profile (ADR 0053 §3): `plan` reads only; nothing reaches outside the turn's folder.
 * Every action allows or denies (see the header); `question` is denied (nobody answers mid-turn: the agent asks in its
 * reply), and `execute` (OpenCode 2's code mode) so our bridge's tools are called by name.
 */
export function opencodePermissions(profile: CommandProfile): Record<string, string> {
  const always = { external_directory: "deny", question: "deny", execute: "deny" };
  return profile === "plan"
    ? { "*": "allow", edit: "deny", bash: "deny", task: "deny", ...always }
    : { "*": "allow", ...always };
}

/**
 * A `chat` turn's permissions (protocol 41, the team's right hand): every tool denied by `*`, ours (`<server>_<tool>`)
 * allowed. OpenCode leaves out of the model's request every tool whose last matching rule denies it, so a tool a new
 * version adds is left out too.
 */
export const OPENCODE_CHAT_PERMISSION: Record<string, string> = { "*": "deny", [`${BRIDGE_PREFIX}*`]: "allow" };

/** The turn's `OPENCODE_CONFIG_CONTENT`: the permissions, the model, the account's key, the free tier's provider. */
export function opencodeConfig(input: {
  profile: CommandProfile;
  /** A `chat` turn: `OPENCODE_CHAT_PERMISSION`. */
  chat?: boolean;
  /**
   * The turn's model: a new session's, and the one that writes its title, as OpenCode otherwise picks a small model
   * of the same provider for that (github.com/anomalyco/opencode issue 56755, 2026-10), a call on a model nobody
   * chose that a key pays for.
   */
  model?: string;
  /** The account has a key: the `opencode` provider reads it from `OPENCODE_API_KEY`. */
  key?: boolean;
  /** The account is a coding plan key (Zen/Go, GLM, Kimi, MiniMax): configures its provider and allows it alone. */
  planKey?: { provider: PlanId };
  /** OpenCode's own provider alone. */
  freeTier?: boolean;
  /** The server's model proxy alone (ADR 9007): `baseUrl` is `<server>/api/model-proxy/v1`; the bearer is in env. */
  proxy?: { baseUrl: string };
}): string {
  let provider: Record<string, unknown> | undefined;
  let enabled: string[] | undefined = input.freeTier ? ["opencode"] : undefined;
  if (input.proxy) {
    provider = {
      [PROXY_PROVIDER]: {
        name: "squadchat",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: input.proxy.baseUrl, apiKey: `{env:${PROXY_KEY_ENV}}` },
        models: { agent: { name: "agent" } },
      },
    };
    enabled = [PROXY_PROVIDER];
  } else if (input.planKey?.provider === "opencode") {
    provider = { "opencode-go": { options: { apiKey: `{env:${OPENCODE_KEY_ENV}}` } } };
    enabled = ["opencode-go"];
  } else if (input.planKey) {
    const plan = planOf(input.planKey.provider);
    if (plan) {
      const p = input.planKey.provider;
      const baseURL = `${plan.claudeCode.baseUrl.replace(/\/+$/, "")}/v1`;
      provider = {
        [p]: {
          name: plan.name,
          npm: "@ai-sdk/anthropic",
          options: { baseURL, apiKey: `{env:${plan.claudeCode.tokenEnv}}` },
          models: Object.fromEntries(
            plan.claudeCode.models.map((m) => [m.id.replace(/\[1m\]$/, ""), { name: m.label }]),
          ),
        },
      };
      enabled = [p];
    }
  } else if (input.key) {
    provider = { opencode: { options: { apiKey: `{env:${OPENCODE_KEY_ENV}}` } } };
  }
  return JSON.stringify({
    permission: input.chat ? OPENCODE_CHAT_PERMISSION : opencodePermissions(input.profile),
    ...(input.model ? { model: input.model, small_model: input.model } : {}),
    // No session title: OpenCode's `ensureTitle` makes a model call per new session unless the `title` agent is gone,
    // a second paid call (and seconds of latency) for a name nothing here shows (ADR 9007).
    agent: { title: { disable: true } },
    share: "disabled",
    autoupdate: false,
    ...(provider ? { provider } : {}),
    ...(enabled ? { enabled_providers: enabled } : {}),
  });
}

/** An MCP server as ACP's `session/new` takes it: stdio, or HTTP with headers. */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

/** Our bridge for one run: `agentes-runner mcp --run <run>` with the token, socket and home in its env, or the URL. */
export function opencodeBridge(input: {
  runId: string;
  token: string;
  url?: string;
  command?: string[];
  socketPath?: string;
  runnerHome: string;
}): AcpMcpServer {
  if (input.url) {
    return {
      type: "http",
      name: CODEX_MCP_SERVER,
      url: input.url,
      headers: [{ name: "Authorization", value: `Bearer ${input.token}` }],
    };
  }
  const [command = "agentes-runner", ...args] = input.command ?? [];
  const [tokenEnv, socketEnv, homeEnv] = CODEX_MCP_ENV;
  return {
    name: CODEX_MCP_SERVER,
    command,
    args: [...args, "mcp", "--run", input.runId],
    env: [
      { name: tokenEnv, value: input.token },
      ...(input.socketPath ? [{ name: socketEnv, value: input.socketPath }] : []),
      { name: homeEnv, value: input.runnerHome },
    ],
  };
}

/** The message: a new session's leads with the engine's context. */
export const opencodePrompt = (system: string, prompt: string, newSession: boolean) =>
  newSession && system.trim() ? `${system.trim()}\n\n${prompt}` : prompt;

/**
 * Where gh finds its sign-in for the agent's commands, whose `XDG_CONFIG_HOME` is OpenCode's emptied folder: where it
 * was before (`GH_CONFIG_DIR`, the old `XDG_CONFIG_HOME`), else gh's own default (`%AppData%\GitHub CLI` on Windows).
 */
export function githubConfigDir(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const set = envValue(env, "GH_CONFIG_DIR", platform);
  if (set) return set;
  const xdg = envValue(env, "XDG_CONFIG_HOME", platform);
  if (xdg) return path.join(xdg, "gh");
  const appData = envValue(env, "APPDATA", platform);
  if (platform === "win32" && appData) return path.win32.join(appData, "GitHub CLI");
  return path.join(home, ".config", "gh");
}

const USAGE_LIMIT =
  /usage limit|rate.?limit|too many requests|\b429\b|quota|insufficient (?:balance|credits|funds)|out of (?:credits|usage)|spend(?:ing)? limit|free (?:tier|usage) (?:limit|exceeded)/i;
/** OpenCode can't authenticate (a revoked or wrong key). */
export const OPENCODE_AUTH =
  /unauthori[sz]ed|\b401\b|invalid (?:api )?key|missing api key|authentication (?:failed|required)/i;
/** OpenCode 2's names (`errorName`) for a provider's limit, and for a refused key. */
const LIMIT_ERRORS =
  /^provider\.(?:free-limit|go-limit|rate-limit|quota|budget-limit|model-budget-limit|chatgpt-limit)$/;
const AUTH_ERRORS = /^provider\.auth$/;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `opencode_failed`. */
export function opencodeProblem(problem: string, worked = false, errorName?: string): CodexBrainEvent[] {
  if ((errorName && LIMIT_ERRORS.test(errorName)) || USAGE_LIMIT.test(problem))
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  if ((errorName && AUTH_ERRORS.test(errorName)) || OPENCODE_AUTH.test(problem))
    return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "opencode_failed", message: problem, retryable: true }];
}

/** An error's words (an ACP error's without JSON-RPC's "Internal error: " in front) and OpenCode 2's error name. */
export function acpProblem(err: unknown): { message: string; errorName?: string; auth: boolean } {
  if (!(err instanceof AcpError)) return { message: err instanceof Error ? err.message : String(err), auth: false };
  const data = isRecord(err.data) ? err.data : {};
  const errorName = str(data.errorName) || undefined;
  const message = err.message.replace(/^(?:Internal error|Invalid params):\s*/i, "") || "OpenCode refused";
  // ACP's "authentication required" (OpenCode 1.x answers a refused key with it).
  const auth = err.code === -32000 || /^auth(?:entication)? required/i.test(err.message);
  return { message, ...(errorName ? { errorName } : {}), auth };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (text: string) =>
  text.length > CODEX_TOOL_OUTPUT_MAX ? `${text.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…` : text;

/** The text of a tool call's ACP content (`[{ type: "content", content: { type: "text", text } }]`), else its raw output. */
function toolText(update: Record<string, unknown>, failed: boolean): string {
  const blocks = Array.isArray(update.content) ? update.content : [];
  const text = blocks
    .map((b) => (isRecord(b) && isRecord(b.content) && b.content.type === "text" ? str(b.content.text) : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  const raw = isRecord(update.rawOutput) ? update.rawOutput : {};
  return (failed ? str(raw.error) : str(raw.output)) || (failed ? "The tool failed." : "");
}

/** One turn's `session/update`s → brain events, plus what the turn's end needs. */
export class OpencodeTurnReader {
  streamed = "";
  /** The text after the turn's last tool call: its answer (what came before was narration). */
  answer = "";
  worked = false;
  /** Tool calls started and not ended (the silence check waits while one runs). */
  readonly running = new Set<string>();
  /** Model steps begun so far: output after a tool ended, or in another message (live steering reads it). */
  steps = 0;
  /** A tool of OpenCode's own in a `chat` turn: why the turn stops. */
  breach?: string;
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private lastMessage?: string;
  private boundary = false;
  private afterTool = false;

  constructor(
    private readonly opts: {
      chat?: boolean;
      redact?: (text: string) => string;
      isBridgeTool?: (name: string) => boolean;
    } = {},
  ) {}

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  private step(messageId?: string) {
    if (this.boundary || (messageId && this.lastMessage && messageId !== this.lastMessage)) {
      this.steps++;
      this.boundary = false;
    }
    if (messageId) this.lastMessage = messageId;
  }

  update(update: unknown): CodexBrainEvent[] {
    if (!isRecord(update)) return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        this.step(str(update.messageId) || undefined);
        if (content.type !== "text") return [];
        const said = this.clean(str(content.text));
        if (!said) return [];
        // Text after a tool call is a paragraph of its own.
        const lead = this.afterTool && this.streamed && !this.streamed.endsWith("\n") ? "\n\n" : "";
        this.afterTool = false;
        this.streamed += lead + said;
        this.answer += said;
        return [{ type: "text_delta", text: lead + said }];
      }
      case "agent_thought_chunk":
        this.step(str(update.messageId) || undefined);
        return [];
      case "tool_call": {
        const id = str(update.toolCallId);
        if (!id) return [];
        this.step();
        // OpenCode 2 names the tool (`name`); 1.x only in its first title (later ones describe the call).
        const name = (str(update.name) || str(update.title) || "tool").slice(0, 128);
        this.tools.set(id, { name, input: update.rawInput ?? {} });
        this.running.add(id);
        this.answer = "";
        this.afterTool = true;
        const ownBridge = this.opts.isBridgeTool ? this.opts.isBridgeTool(name) : name.startsWith(BRIDGE_PREFIX);
        if (this.opts.chat && !ownBridge && !this.breach) {
          this.breach = `OpenCode called a tool of its own (${name}), so the turn stopped.`;
        }
        return [];
      }
      case "tool_call_update": {
        const id = str(update.toolCallId);
        const tool = this.tools.get(id);
        if (!tool) return [];
        if (update.rawInput !== undefined) tool.input = update.rawInput;
        const status = str(update.status);
        if (status !== "completed" && status !== "failed") return [];
        this.running.delete(id);
        this.tools.delete(id);
        this.worked = true;
        this.boundary = true;
        // Our bridge's tools: the engine records its own calls.
        const ownBridge = this.opts.isBridgeTool
          ? this.opts.isBridgeTool(tool.name)
          : tool.name.startsWith(BRIDGE_PREFIX);
        if (ownBridge) return [];
        const failed = status === "failed";
        return [
          {
            type: "tool_call",
            id,
            name: tool.name,
            input: redactDeep(isRecord(tool.input) ? tool.input : {}, (t) => this.clean(t)),
            executed: { content: cut(this.clean(toolText(update, failed))), ...(failed ? { isError: true } : {}) },
          },
        ];
      }
      default:
        return [];
    }
  }

  /** The prompt's `usage` as our event (every input token, cache included; thinking counts as output). */
  usage(usage: unknown, model?: string): CodexBrainEvent[] {
    if (!isRecord(usage)) return [];
    const cacheRead = num(usage.cachedReadTokens);
    const cacheWrite = num(usage.cachedWriteTokens);
    const input = num(usage.inputTokens) + cacheRead + cacheWrite;
    const output = num(usage.outputTokens) + num(usage.thoughtTokens);
    if (!input && !output) return [];
    return [
      {
        type: "usage",
        input,
        output,
        source: "plan",
        ...(model ? { model } : {}),
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
      },
    ];
  }
}

type SteerMessage = { uuid: string; text: string; urgent?: boolean };

/** A live OpenCode turn that `brain.steer` can reach, by run. */
interface LiveTurn {
  agentId: string;
  session: string;
  steer(messages: SteerMessage[]): Promise<BrainSteerReply>;
}
const liveTurns = new Map<string, LiveTurn>();

/**
 * `brain.steer` for an OpenCode turn of `runId` (the request's agent's, that session's), or null when no OpenCode turn
 * of that run runs here.
 */
export function steerOpencodeTurn(
  agentId: string,
  req: { runId: string; session: string; messages: SteerMessage[] },
): Promise<BrainSteerReply> | null {
  const live = liveTurns.get(req.runId);
  if (!live) return null;
  if (live.agentId !== agentId || live.session !== req.session) return Promise.resolve({ status: "no_turn" });
  return live.steer(req.messages);
}

export interface OpencodeTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account (its sessions are its own): its folder, and its key (OpenCode or Coding Plan). */
  account?: { id: string; home: string; key?: string; planKey?: { provider: PlanId; key: string } };
  profile?: CommandProfile;
  freeTier?: boolean;
  /** Protocol 41: the team's right hand, OpenCode's tools all off, stopped at the first one it calls anyway. */
  chat?: boolean;
  /** The turn thinks through the server's model proxy: `baseUrl` is `<server>/api/model-proxy/v1`, the bearer `mcp.token`. */
  proxy?: { baseUrl: string };
  /** The turn's agent (for `brain.steer`). */
  agentId?: string;
  /** The agent's own folder (for matching `brain.warm` checkout fallback). */
  folder?: string;
  keepAlive?: boolean;
}

export interface OpencodeTurnOptions {
  sessions: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Tests: the executable, how it starts, the system, the silence limit, and the exit grace. */
  bin?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  silenceMs?: number;
  exitGraceMs?: number;
}

/** The session key: per account and folder (a resumed OpenCode session keeps the folder it started in). */
export const opencodeSessionKey = (sessionId: string, account: string | undefined, cwd: string) =>
  `${codexThreadKey(sessionId, account)}|${cwd}`;

function accountKeySecrets(
  account: { key?: string; planKey?: { provider: PlanId; key: string } } | undefined,
  proxyKey?: string,
) {
  const out: { name: string; value: string }[] = [];
  if (proxyKey) out.push({ name: PROXY_KEY_ENV, value: proxyKey });
  if (account?.key) out.push({ name: OPENCODE_KEY_ENV, value: account.key });
  if (account?.planKey) {
    const name =
      account.planKey.provider === "opencode"
        ? OPENCODE_KEY_ENV
        : (planOf(account.planKey.provider)?.claudeCode.tokenEnv ?? "PLAN_KEY");
    out.push({ name, value: account.planKey.key });
  }
  return out;
}

/** The env one turn's `opencode acp` runs with (see the header). */
export function opencodeTurnEnv(input: {
  inherited: NodeJS.ProcessEnv;
  cwd: string;
  configDir: string;
  config: string;
  account?: { home: string; key?: string; planKey?: { provider: PlanId; key: string } };
  freeTier?: boolean;
  chat?: boolean;
  /** The turn's bearer for the server's model proxy (ADR 9007). */
  proxyKey?: string;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const inherited: NodeJS.ProcessEnv = { ...input.inherited };
  const unwanted = new Set([
    "OPENCODE_PERMISSION",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
  ]);
  for (const k of Object.keys(inherited)) if (unwanted.has(k.toUpperCase())) delete inherited[k];
  const home = envValue(inherited, "HOME", platform) || envValue(inherited, "USERPROFILE", platform) || os.homedir();
  const base = input.freeTier && !input.account ? withoutSignIns(inherited) : inherited;
  const env = input.account ? accountEnv("opencode", input.account.home, base) : { ...base };
  // The agent's commands inherit XDG_CONFIG_HOME: gh keeps finding its sign-in where it was.
  env.GH_CONFIG_DIR = githubConfigDir(inherited, home, platform);
  env.XDG_CONFIG_HOME = input.configDir;
  env.OPENCODE_CONFIG_DIR = input.configDir;
  env.OPENCODE_CONFIG_CONTENT = input.config;
  if (input.account?.key) env[OPENCODE_KEY_ENV] = input.account.key;
  if (input.proxyKey) env[PROXY_KEY_ENV] = input.proxyKey;
  if (input.account?.planKey) {
    const { provider, key } = input.account.planKey;
    const plan = planOf(provider);
    if (provider === "opencode") env[OPENCODE_KEY_ENV] = key;
    else if (plan) {
      if (plan.claudeCode.env) Object.assign(env, plan.claudeCode.env);
      env[plan.claudeCode.tokenEnv] = key;
    }
  }
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // Language servers would be downloaded, unpinned, into each agent's home.
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  // OpenCode reads the computer's `~/.claude/CLAUDE.md` into every session: none in a `chat` turn.
  if (input.chat) env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  // OpenCode 2 starts in `$PWD` when it is set: the turn's folder, never the runner's own.
  env.PWD = input.cwd;
  return env;
}

/** `p`, or a rejection after `ms` (the timer cleared either way). */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Whether the process has exited within `ms`. */
const goneWithin = (exited: Promise<unknown>, ms: number) =>
  within(
    exited.then(() => true),
    ms,
    "",
  ).catch(() => false);

/** An error that carries how the process ended (it closed the connection). */
type ExitError = Error & { exit?: { code: number | null; error?: Error } };

/** Runs one OpenCode turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runOpencodeTurn(input: OpencodeTurnInput, opts: OpencodeTurnOptions): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const startedAt = Date.now();
  let initMs: number | undefined;
  let firstEventMs: number | undefined;
  let firstTokenMs: number | undefined;
  let ended = false;
  const emit = (event: CodexBrainEvent) => {
    if (ended) return;
    const elapsed = Date.now() - startedAt;
    firstEventMs ??= elapsed;
    if (event.type === "text_delta" && event.text) firstTokenMs ??= elapsed;
    if (event.type === "done" || event.type === "error") ended = true;
    opts.emit(event);
  };
  const fail = (code: string, message: string, retryable?: boolean) =>
    emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });

  const inherited: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const home = envValue(inherited, "HOME", platform) || envValue(inherited, "USERPROFILE", platform) || os.homedir();
  const planted = opencodeHomePlanted(home);
  if (planted.length) {
    return fail(
      "opencode_failed",
      `OpenCode on this computer reads ${planted.join(", ")} in ${path.join(home, ".opencode")} on every run, which could change what an agent may do. Move them out of that folder for agents to think with OpenCode.`,
    );
  }
  const configDir = opencodeConfigDir(opts.runnerHome);
  try {
    resetOpencodeConfig(configDir);
  } catch (err) {
    return fail("opencode_failed", err instanceof Error ? err.message : String(err), true);
  }
  const key = input.account?.key;
  const planKey = input.account?.planKey;
  const freeTier = Boolean(input.freeTier && !input.account);
  const env = opencodeTurnEnv({
    inherited,
    cwd: input.cwd,
    configDir,
    config: opencodeConfig({
      profile: input.profile ?? "work",
      ...(input.chat ? { chat: true } : {}),
      ...(input.model ? { model: input.model } : {}),
      key: Boolean(key),
      ...(planKey ? { planKey: { provider: planKey.provider } } : {}),
      freeTier,
      ...(input.proxy ? { proxy: input.proxy } : {}),
    }),
    ...(input.account ? { account: input.account } : {}),
    freeTier,
    ...(input.chat ? { chat: true } : {}),
    ...(input.proxy ? { proxyKey: input.mcp.token } : {}),
    platform,
  });
  // The agent's shell could print the key (its env, its file in the lent folder).
  const secrets = accountKeySecrets(input.account, input.proxy ? input.mcp.token : undefined);
  const redact = secrets.length
    ? (text: string) => redactSecrets(opts.redact ? opts.redact(text) : text, secrets)
    : opts.redact;

  const run = cliSpawn([opts.bin ?? OPENCODE_BIN], ["acp"], envValue(env, "PATH", platform), platform);
  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(run.file, run.args, {
      cwd: input.cwd,
      env: run.env ? { ...env, ...run.env } : env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so `killTree` takes what it started along. Not on Windows: there it would open a
      // console of its own, and `taskkill /T` follows the tree anyway.
      detached: !windows,
      windowsHide: true,
      ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "opencode_missing" : "opencode_failed",
      missing ? "OpenCode's CLI is not installed on this computer." : String(err),
      true,
    );
  }

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-2000);
  });
  const reader = new OpencodeTurnReader({ ...(input.chat ? { chat: true } : {}), ...(redact ? { redact } : {}) });
  const sessionKey = opencodeSessionKey(input.sessionId, input.account?.id, input.cwd);
  /** What the turn's callbacks change as it goes. */
  const s = {
    sessionId: null as string | null,
    admitted: false,
    refusedAsk: null as string | null,
    stopping: null as "canceled" | "silence" | "breach" | null,
    killTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  /** Messages handed with `brain.steer` and not read yet, with the step they were handed at. */
  const steered: { uuids: string[]; step: number }[] = [];
  const readSteered = (all: boolean) => {
    const read = steered.filter((m) => all || reader.steps > m.step);
    if (!read.length) return;
    steered.splice(0, steered.length, ...steered.filter((m) => !read.includes(m)));
    emit({ type: "steer_read", uuids: read.flatMap((m) => m.uuids) });
  };
  // The session holds the prompt (and the context it led with) once OpenCode took it: kept for the next turn.
  const admit = () => {
    if (s.admitted || !s.sessionId) return;
    s.admitted = true;
    opts.sessions.set(sessionKey, s.sessionId);
  };

  const conn = new AcpConnection(
    child.stdin as NonNullable<ChildProcess["stdin"]>,
    child.stdout as NonNullable<ChildProcess["stdout"]>,
    {
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== s.sessionId) return;
        // A `chat` turn that met a tool of OpenCode's own says nothing more: what that tool did goes nowhere.
        if (s.stopping === "breach") return;
        admit();
        const events = reader.update(params.update);
        if (reader.breach) return stop("breach");
        for (const event of events) emit(event);
        readSteered(false);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        // Nothing of ours asks (every rule allows or denies): a rule that asks comes from another config. Refused.
        const p = isRecord(params) ? params : {};
        const call = isRecord(p.toolCall) ? p.toolCall : {};
        s.refusedAsk ??= str(call.title) || str(call.name) || "use a tool";
        const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
        const reject = options.find((o) => str(o.kind).startsWith("reject"));
        return reject
          ? { outcome: { outcome: "selected", optionId: str(reject.optionId) } }
          : { outcome: { outcome: "cancelled" } };
      },
    },
  );

  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    const proc = child as unknown as EventEmitter;
    proc.on("error", (error: Error) => resolve({ code: null, error }));
    proc.on("close", (code: number | null) => resolve({ code }));
  });
  void exited.then(({ code, error }) => {
    const why =
      error?.message ?? `OpenCode exited with code ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    const closed: ExitError = new Error(redact ? redact(why) : why);
    closed.exit = { code, ...(error ? { error } : {}) };
    conn.close(closed);
  });

  /** Asks OpenCode to stop the turn, then kills it if it doesn't. */
  function stop(why: "canceled" | "silence" | "breach") {
    if (s.stopping) return;
    s.stopping = why;
    if (s.sessionId) conn.notify("session/cancel", { sessionId: s.sessionId });
    // A tool of its own in a `chat` turn: no waiting for it to run.
    s.killTimer = setTimeout(() => killTree(child, "SIGKILL"), why === "breach" ? 0 : STOP_WAIT_MS);
  }
  const onAbort = () => stop("canceled");
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const silenceMs = opts.silenceMs ?? OPENCODE_SILENCE_MS;
  const silence = setInterval(
    () => {
      if (s.sessionId && reader.running.size === 0 && Date.now() - conn.lastHeard > silenceMs) stop("silence");
    },
    Math.min(15_000, Math.max(50, silenceMs / 4)),
  );
  const setup = <T>(p: Promise<T>) => within(p, SETUP_TIMEOUT_MS, "OpenCode took too long to start");
  /** A turn we stopped ends with why (true), whatever OpenCode answered meanwhile. */
  const stopped = () => {
    if (s.stopping === "canceled") fail("canceled", "The turn was canceled.");
    else if (s.stopping === "breach") {
      fail("tools_not_locked", reader.breach ?? "OpenCode called a tool of its own, so the turn stopped.");
    } else if (s.stopping === "silence") {
      const span =
        silenceMs >= 60_000 ? `${Math.round(silenceMs / 60_000)} minutes` : `${Math.round(silenceMs / 1000)} seconds`;
      fail(
        "opencode_failed",
        `OpenCode said nothing for ${span} with no tool running (its provider may be refusing it, as at a usage limit), so the turn stopped.`,
        true,
      );
    }
    return s.stopping !== null;
  };

  try {
    const init = await setup(
      conn.request<Record<string, unknown> | null>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agentes-runner", version: "1" },
      }),
    );
    const caps = isRecord(init?.agentCapabilities) ? init.agentCapabilities : {};
    const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
    const version = isRecord(init?.agentInfo) ? str(init.agentInfo.version) : "";
    const meta = isRecord(init?._meta) ? init._meta : {};
    const steering = isRecord(meta.steering) && meta.steering.supported === true;
    const bridge = opencodeBridge({
      runId: input.runId,
      token: input.mcp.token,
      ...(input.mcp.url ? { url: input.mcp.url } : {}),
      ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
      ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
      runnerHome: opts.runnerHome,
    });

    // A stored session is resumed; one OpenCode no longer has (or can't resume) starts over, with the context.
    const stored = opts.sessions.get(sessionKey);
    let opened: Record<string, unknown> | null = null;
    const resume = isRecord(sessionCaps.resume) ? "session/resume" : caps.loadSession === true ? "session/load" : null;
    if (stored && resume && !s.stopping) {
      // A load replays the history as updates: none of them is this turn's.
      s.sessionId = resume === "session/resume" ? stored : null;
      opened = await setup(
        conn.request<Record<string, unknown> | null>(resume, {
          sessionId: stored,
          cwd: input.cwd,
          mcpServers: [bridge],
        }),
      ).then(
        (r) => r ?? {},
        () => null,
      );
      if (opened) {
        s.sessionId = stored;
        s.admitted = true;
      } else {
        s.sessionId = null;
        opts.sessions.delete(sessionKey);
      }
    } else if (stored) opts.sessions.delete(sessionKey);
    const fresh = !opened;
    if (fresh && !s.stopping) {
      opened = await setup(
        conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridge] }),
      );
      s.sessionId = str(opened?.sessionId) || null;
      if (!s.sessionId) throw new Error("OpenCode didn't start a session");
    }
    if (input.model && s.sessionId && !s.stopping) {
      const options = Array.isArray(opened?.configOptions) ? opened.configOptions.filter(isRecord) : [];
      if (str(options.find((o) => o.id === "model")?.currentValue) !== input.model) {
        await setup(
          conn.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: input.model }),
        ).catch((err: unknown) => {
          throw new Error(`OpenCode here doesn't offer ${input.model}: ${acpProblem(err).message}`);
        });
      }
    }

    const sessionId = s.sessionId;
    if (input.agentId && sessionId) {
      liveTurns.set(input.runId, {
        agentId: input.agentId,
        session: input.sessionId,
        steer: async (messages) => {
          if (!steering) {
            return { status: "unsupported", reason: `OpenCode ${version || "here"} reads messages only between turns` };
          }
          if (messages.some((m) => m.urgent)) {
            return { status: "unsupported", reason: "OpenCode can't take an urgent message mid-turn" };
          }
          if (s.stopping || ended || conn.closed) return { status: "no_turn" };
          const step = reader.steps;
          const reply = await conn
            .request<Record<string, unknown> | null>("_session/steering", {
              sessionId,
              prompt: messages.map((m) => ({ type: "text", text: m.text })),
            })
            .catch(() => null);
          if (reply?.outcome !== "injected") return { status: "no_turn" };
          const uuids = messages.map((m) => m.uuid);
          steered.push({ uuids, step });
          return { status: "accepted", accepted: uuids };
        },
      });
    }

    if (stopped()) return;
    initMs = Date.now() - startedAt;
    const answer = await conn
      .request<Record<string, unknown> | null>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opencodePrompt(input.system, input.prompt, fresh) }],
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    liveTurns.delete(input.runId);
    if (answer.ok) {
      admit();
      for (const event of reader.usage(answer.result?.usage, input.model)) emit(event);
    }
    if (stopped()) return;
    if (!answer.ok) {
      if ((answer.error as ExitError).exit) throw answer.error;
      const problem = acpProblem(answer.error);
      if (problem.auth) return fail("not_logged_in", problem.message, true);
      for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) emit(event);
      return;
    }
    const stopReason = str(answer.result?.stopReason);
    if (stopReason === "cancelled") {
      return fail(
        "opencode_failed",
        s.refusedAsk
          ? `OpenCode asked for permission to ${s.refusedAsk}, which this agent may not do here, so the turn stopped.`
          : "OpenCode stopped the turn by itself.",
        true,
      );
    }
    const text = reader.answer || reader.streamed;
    if (stopReason === "refusal" && !text.trim()) return fail("model_refused", "The model refused to answer.");
    readSteered(true);
    firstEventMs ??= Date.now() - startedAt;
    emit({
      type: "done",
      text,
      session: { id: input.sessionId },
      timings: {
        warm: false,
        cold: fresh ? "new_session" : "restart",
        ...(initMs !== undefined ? { initMs } : {}),
        ...(firstEventMs !== undefined ? { firstEventMs } : {}),
        ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      },
    });
  } catch (err) {
    if (stopped()) return;
    const exit = (err as ExitError).exit;
    const missing =
      (exit?.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (windows && exit?.code === 9009);
    if (missing) return fail("opencode_missing", "OpenCode's CLI is not installed on this computer.", true);
    const problem = acpProblem(err);
    for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) emit(event);
  } finally {
    liveTurns.delete(input.runId);
    clearInterval(silence);
    clearTimeout(s.killTimer);
    opts.signal.removeEventListener("abort", onAbort);
    conn.close();
    if (!ended) fail("opencode_failed", "OpenCode ended without an answer.", true);
    // Done: its input closed, it exits by itself; still running after the grace, it is ended with its tree. The turn
    // returns once it has gone, so nothing it started (our bridge's process among them) outlives the turn's token.
    child.stdin?.end();
    if (!(await goneWithin(exited, s.stopping === "breach" ? 0 : (opts.exitGraceMs ?? EXIT_GRACE_MS)))) {
      killTree(child, "SIGTERM");
      if (!(await goneWithin(exited, KILL_WAIT_MS))) {
        killTree(child, "SIGKILL");
        await goneWithin(exited, KILL_WAIT_MS);
      }
    }
  }
}

/** What the runner's `brain.turn` handler hands the OpenCode branch. */
interface OpencodeLive {
  key: string;
  id: string;
  agentId: string;
  account: string | null;
  sessionKey: string;
  acpSessionId: string;
  hasContext: boolean;
  model: string | undefined;
  version: string;
  steering: boolean;
  child: ChildProcess;
  conn: AcpConnection;
  exited: boolean;
  exitedPromise: Promise<{ code: number | null; error?: Error }>;
  stderr: () => string;
  sig: string;
  busy: boolean;
  lastUsed: number;
  idleSince: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  bridge: McpTaskInfo | null;
  release?: () => void;
}

export interface OpencodeServersOptions {
  runs: Map<string, McpTaskInfo>;
  idleMs?: number;
  maxProcesses?: number;
  spawn?: Spawn;
  log?: (line: string) => void;
}

/** A rotated key in the same folder must not reuse the old process: a short one-way print, never the key. */
export const keyPrint = (key?: string) => (key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : null);

const modelProvider = (model?: string) => (model?.includes("/") ? model.slice(0, model.indexOf("/")) : null);

/** Long-lived `opencode acp` processes per `(agent, session, account, cwd)`, with `brain.warm` pre-spawning. */
export class OpencodeServers {
  private readonly live = new Map<string, OpencodeLive>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cwds = new Map<string, string>();
  private closed = false;
  private readonly relay = new ProxyRelay();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: OpencodeServersOptions) {
    this.log = opts.log ?? (() => {});
  }

  setLimits(limits: { idleMs?: number; maxProcesses?: number }) {
    if (limits.idleMs !== undefined) this.opts.idleMs = limits.idleMs;
    if (limits.maxProcesses !== undefined) this.opts.maxProcesses = limits.maxProcesses;
  }

  warm(key: string): boolean {
    const l = this.live.get(key);
    return l !== undefined && !l.exited;
  }

  private signature(input: OpencodeTurnInput, opts: OpencodeTurnOptions) {
    return JSON.stringify({
      cwd: input.cwd,
      account: input.account?.home ?? null,
      key: keyPrint(input.account?.key),
      planProvider: input.account?.planKey?.provider ?? null,
      planKey: keyPrint(input.account?.planKey?.key),
      provider: modelProvider(input.model),
      proxy: input.proxy?.baseUrl ?? null,
      profile: input.profile ?? "work",
      freeTier: Boolean(input.freeTier && !input.account),
      chat: Boolean(input.chat),
      bin: opts.bin ?? OPENCODE_BIN,
      mcp: opts.mcpCommand ?? null,
      socket: opts.socketPath ?? null,
      env: opts.env ?? {},
    });
  }

  async prewarm(
    input: Omit<OpencodeTurnInput, "runId" | "prompt" | "system" | "mcp">,
    opts: Omit<OpencodeTurnOptions, "emit" | "signal">,
    release?: () => void,
  ): Promise<BrainWarmReply> {
    const no: BrainWarmReply = { open: false, started: false };
    let hold = release;
    try {
      if (this.closed || !input.agentId) return no;
      const last = input.folder && input.cwd === input.folder ? this.cwds.get(input.agentId) : undefined;
      const cwd = last && isInside(input.folder as string, last) && existsSync(last) ? last : input.cwd;
      const sessionKey = opencodeSessionKey(input.sessionId, input.account?.id, cwd);
      const key = `${input.agentId}:${sessionKey}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const consume = () => {
        const r = hold;
        hold = undefined;
        return r;
      };
      const run = prev
        .catch(() => undefined)
        .then(async (): Promise<BrainWarmReply> => {
          if (this.closed) return no;
          const dummyInput: OpencodeTurnInput = {
            ...input,
            cwd,
            runId: "warm",
            system: "",
            prompt: "",
            mcp: { token: "" },
          };
          const dummyOpts: OpencodeTurnOptions = {
            ...opts,
            emit: () => {},
            signal: new AbortController().signal,
          };
          const sig = this.signature(dummyInput, dummyOpts);
          let existing = this.live.get(key);
          if (existing && (existing.exited || existing.sig !== sig)) {
            this.drop(existing);
            existing = undefined;
          }
          if (existing) {
            if (!existing.busy) {
              existing.lastUsed = Date.now();
              this.armIdle(existing);
            }
            return { open: true, started: false };
          }
          const agent = input.agentId ?? "";
          if (this.alive(agent) >= this.max && !this.lruIdle(agent)) return no;
          const started = await this.start(key, sessionKey, sig, dummyInput, dummyOpts, consume);
          if (!started) return no;
          this.armIdle(started);
          return { open: true, started: true };
        });
      this.chains.set(key, run);
      try {
        return await run;
      } finally {
        if (this.chains.get(key) === run) this.chains.delete(key);
      }
    } finally {
      hold?.();
    }
  }

  async turn(input: OpencodeTurnInput, opts: OpencodeTurnOptions, release?: () => void): Promise<void> {
    let hold = release;
    try {
      if (this.closed || input.mcp.url || !input.agentId) return await runOpencodeTurn(input, opts);
      this.cwds.set(input.agentId, input.cwd);
      const sessionKey = opencodeSessionKey(input.sessionId, input.account?.id, input.cwd);
      const key = `${input.agentId}:${sessionKey}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const consume = () => {
        const r = hold;
        hold = undefined;
        return r;
      };
      const run = prev.catch(() => undefined).then(() => this.runPooled(key, sessionKey, input, opts, consume));
      this.chains.set(key, run);
      let handled = false;
      try {
        handled = await run;
      } catch (err) {
        this.log(`opencode pool turn failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (this.chains.get(key) === run) this.chains.delete(key);
      }
      if (!handled) await runOpencodeTurn(input, opts);
    } finally {
      hold?.();
    }
  }

  private async runPooled(
    key: string,
    sessionKey: string,
    input: OpencodeTurnInput,
    opts: OpencodeTurnOptions,
    acquireRelease?: () => (() => void) | undefined,
  ): Promise<boolean> {
    if (opts.signal.aborted) {
      opts.emit({ type: "error", code: "canceled", message: "The turn was canceled." });
      return true;
    }
    const startedAt = Date.now();
    let warm = false;
    let cold: BrainColdCause | undefined;
    let initMs: number | undefined;
    let firstEventMs: number | undefined;
    let firstTokenMs: number | undefined;
    let emitted = false;
    let ended = false;
    const emit = (event: CodexBrainEvent) => {
      if (ended) return;
      emitted = true;
      const elapsed = Date.now() - startedAt;
      firstEventMs ??= elapsed;
      if (event.type === "text_delta" && event.text) firstTokenMs ??= elapsed;
      if (event.type === "done" || event.type === "error") ended = true;
      opts.emit(event);
    };
    const sig = this.signature(input, opts);
    let live = this.live.get(key);
    if (live && (live.exited || live.sig !== sig)) {
      cold = live.exited ? "exited" : "settings";
      this.drop(live);
      live = undefined;
    }
    warm = Boolean(live);
    if (!live) {
      cold ??= opts.sessions.get(sessionKey) ? "restart" : "new_session";
      const agent = input.agentId ?? "";
      const lru = this.alive(agent) >= this.max ? this.lruIdle(agent) : undefined;
      if (lru) this.drop(lru);
      const started = await this.start(key, sessionKey, sig, input, opts, acquireRelease);
      if (!started) return false;
      initMs = Date.now() - startedAt;
      live = started;
    }
    const outcome = await this.onLive(live, input, opts, {
      emit,
      hasEnded: () => ended,
      timings: () => ({
        warm,
        ...(!warm && cold ? { cold } : {}),
        ...(initMs !== undefined ? { initMs } : {}),
        ...(firstEventMs !== undefined ? { firstEventMs } : {}),
        ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      }),
    });
    if (outcome.died && !emitted) {
      this.drop(live);
      return false;
    }
    if (outcome.drop || input.keepAlive === false) this.drop(live);
    return true;
  }

  private async start(
    key: string,
    sessionKey: string,
    sig: string,
    input: OpencodeTurnInput,
    opts: OpencodeTurnOptions,
    acquireRelease?: () => (() => void) | undefined,
  ): Promise<OpencodeLive | null> {
    const platform = opts.platform ?? process.platform;
    const windows = platform === "win32";
    const inherited: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
    const home = envValue(inherited, "HOME", platform) || envValue(inherited, "USERPROFILE", platform) || os.homedir();
    if (opencodeHomePlanted(home).length) return null;
    const configDir = opencodeConfigDir(opts.runnerHome);
    try {
      resetOpencodeConfig(configDir);
    } catch {
      return null;
    }
    const id = randomUUID();
    const token = newMcpToken();
    const apiKey = input.account?.key;
    const planKey = input.account?.planKey;
    const freeTier = Boolean(input.freeTier && !input.account);
    // A proxied turn (ADR 9007) reaches the server through the loopback relay, which adds the running turn's bearer.
    const relayUrl = input.proxy
      ? this.relay.register(id, input.proxy.baseUrl, () => this.opts.runs.get(id)?.serverToken)
      : undefined;
    const env = opencodeTurnEnv({
      inherited,
      cwd: input.cwd,
      configDir,
      config: opencodeConfig({
        profile: input.profile ?? "work",
        ...(input.chat ? { chat: true } : {}),
        ...(input.model ? { model: input.model } : {}),
        key: Boolean(apiKey),
        ...(planKey ? { planKey: { provider: planKey.provider } } : {}),
        ...(relayUrl ? { proxy: { baseUrl: relayUrl } } : {}),
        freeTier,
      }),
      ...(relayUrl ? { proxyKey: "relay" } : {}),
      ...(input.account ? { account: input.account } : {}),
      freeTier,
      ...(input.chat ? { chat: true } : {}),
      platform,
    });
    const run = cliSpawn([opts.bin ?? OPENCODE_BIN], ["acp"], envValue(env, "PATH", platform), platform);
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? opts.spawn ?? spawn)(run.file, run.args, {
        cwd: input.cwd,
        env: run.env ? { ...env, ...run.env } : env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: !windows,
        windowsHide: true,
        ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      this.relay.forget(id);
      return null;
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    const conn = new AcpConnection(
      child.stdin as NonNullable<ChildProcess["stdin"]>,
      child.stdout as NonNullable<ChildProcess["stdout"]>,
      {
        onRequest(method) {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        },
      },
    );
    let exited = false;
    const exitedPromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      const proc = child as unknown as EventEmitter;
      proc.on("error", (error: Error) => {
        exited = true;
        conn.close(error);
        resolve({ code: null, error });
      });
      proc.on("close", (code: number | null) => {
        exited = true;
        conn.close(new Error(`OpenCode exited with code ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        resolve({ code });
      });
    });
    const setup = <T>(p: Promise<T>) => within(p, SETUP_TIMEOUT_MS, "OpenCode took too long to start");
    try {
      const init = await setup(
        conn.request<Record<string, unknown> | null>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agentes-runner", version: "1" },
        }),
      );
      const caps = isRecord(init?.agentCapabilities) ? init.agentCapabilities : {};
      const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
      const version = isRecord(init?.agentInfo) ? str(init.agentInfo.version) : "";
      const meta = isRecord(init?._meta) ? init._meta : {};
      const steering = isRecord(meta.steering) && meta.steering.supported === true;
      const bridgeServer = opencodeBridge({
        runId: id,
        token,
        ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
        ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
        runnerHome: opts.runnerHome,
      });
      const stored = opts.sessions.get(sessionKey);
      const resume = isRecord(sessionCaps.resume)
        ? "session/resume"
        : caps.loadSession === true
          ? "session/load"
          : null;
      let acpSessionId: string | null = null;
      let hasContext = false;
      let opened: Record<string, unknown> | null = null;
      if (stored && resume) {
        opened = await setup(
          conn.request<Record<string, unknown> | null>(resume, {
            sessionId: stored,
            cwd: input.cwd,
            mcpServers: [bridgeServer],
          }),
        ).then(
          (r) => r ?? {},
          () => null,
        );
        if (opened) {
          acpSessionId = stored;
          hasContext = true;
        } else {
          opts.sessions.delete(sessionKey);
        }
      } else if (stored) {
        opts.sessions.delete(sessionKey);
      }
      if (!acpSessionId) {
        opened = await setup(
          conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridgeServer] }),
        );
        acpSessionId = str(opened?.sessionId) || null;
        if (!acpSessionId) throw new Error("OpenCode didn't start a session");
      }
      const configOpts = Array.isArray(opened?.configOptions) ? opened.configOptions.filter(isRecord) : [];
      let currentModel = str(configOpts.find((o) => o.id === "model")?.currentValue) || undefined;
      if (input.model && currentModel !== input.model) {
        await setup(
          conn.request("session/set_config_option", { sessionId: acpSessionId, configId: "model", value: input.model }),
        );
        currentModel = input.model;
      }
      if (this.closed || exited) {
        this.relay.forget(id);
        conn.close();
        killTree(child, "SIGTERM");
        return null;
      }
      const bridge: McpTaskInfo = {
        token,
        missionId: "",
        running: false,
        idle: true,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        cwd: input.cwd,
        folder: input.folder ?? input.cwd,
      };
      this.opts.runs.set(id, bridge);
      const release = acquireRelease?.();
      const live: OpencodeLive = {
        key,
        id,
        agentId: input.agentId ?? "",
        account: input.account?.id ?? null,
        sessionKey,
        acpSessionId,
        hasContext,
        model: currentModel ?? input.model,
        version,
        steering,
        child,
        conn,
        exited: false,
        exitedPromise,
        stderr: () => stderr,
        sig,
        busy: false,
        lastUsed: Date.now(),
        idleSince: awakeClock.read(),
        idleTimer: null,
        bridge,
        ...(release ? { release } : {}),
      };
      void exitedPromise.then(() => {
        live.exited = true;
        if (!live.busy) this.drop(live);
      });
      this.live.set(key, live);
      return live;
    } catch {
      this.relay.forget(id);
      conn.close();
      killTree(child, "SIGTERM");
      return null;
    }
  }

  private async onLive(
    live: OpencodeLive,
    input: OpencodeTurnInput,
    opts: OpencodeTurnOptions,
    turn: { emit: (e: CodexBrainEvent) => void; hasEnded: () => boolean; timings: () => BrainTurnTimings },
  ): Promise<{ died?: boolean; drop?: boolean }> {
    live.busy = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    const secrets = accountKeySecrets(input.account);
    const redact = secrets.length
      ? (text: string) => redactSecrets(opts.redact ? opts.redact(text) : text, secrets)
      : opts.redact;
    if (live.bridge) {
      this.opts.runs.set(live.id, {
        token: live.bridge.token,
        missionId: "",
        running: true,
        ...(live.agentId ? { agentId: live.agentId } : {}),
        cwd: live.bridge.cwd ?? input.cwd,
        folder: live.bridge.folder ?? input.cwd,
        runId: input.runId,
        serverToken: input.mcp.token,
        ...(redact ? { redact } : {}),
      });
    }
    const reader = new OpencodeTurnReader({ ...(input.chat ? { chat: true } : {}), ...(redact ? { redact } : {}) });
    const s = {
      stopping: null as "canceled" | "silence" | "breach" | null,
      refusedAsk: null as string | null,
      killTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const steered: { uuids: string[]; step: number }[] = [];
    const readSteered = (all: boolean) => {
      const read = steered.filter((m) => all || reader.steps > m.step);
      if (!read.length) return;
      steered.splice(0, steered.length, ...steered.filter((m) => !read.includes(m)));
      turn.emit({ type: "steer_read", uuids: read.flatMap((m) => m.uuids) });
    };
    const admit = () => {
      if (live.hasContext) return;
      live.hasContext = true;
      opts.sessions.set(live.sessionKey, live.acpSessionId);
    };
    const fail = (code: string, message: string, retryable?: boolean) =>
      turn.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
    const stop = (why: "canceled" | "silence" | "breach") => {
      if (s.stopping) return;
      s.stopping = why;
      live.conn.notify("session/cancel", { sessionId: live.acpSessionId });
      s.killTimer = setTimeout(() => killTree(live.child, "SIGKILL"), why === "breach" ? 0 : STOP_WAIT_MS);
    };
    const onAbort = () => stop("canceled");
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    const silenceMs = opts.silenceMs ?? OPENCODE_SILENCE_MS;
    const silence = setInterval(
      () => {
        if (reader.running.size === 0 && Date.now() - live.conn.lastHeard > silenceMs) stop("silence");
      },
      Math.min(15_000, Math.max(50, silenceMs / 4)),
    );
    live.conn.setHandlers({
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== live.acpSessionId) return;
        if (s.stopping === "breach") return;
        admit();
        const events = reader.update(params.update);
        if (reader.breach) return stop("breach");
        for (const event of events) turn.emit(event);
        readSteered(false);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        const p = isRecord(params) ? params : {};
        const call = isRecord(p.toolCall) ? p.toolCall : {};
        s.refusedAsk ??= str(call.title) || str(call.name) || "use a tool";
        const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
        const reject = options.find((o) => str(o.kind).startsWith("reject"));
        return reject
          ? { outcome: { outcome: "selected", optionId: str(reject.optionId) } }
          : { outcome: { outcome: "cancelled" } };
      },
    });
    if (input.agentId) {
      liveTurns.set(input.runId, {
        agentId: input.agentId,
        session: input.sessionId,
        steer: async (messages) => {
          if (!live.steering) {
            return {
              status: "unsupported",
              reason: `OpenCode ${live.version || "here"} reads messages only between turns`,
            };
          }
          if (messages.some((m) => m.urgent)) {
            return { status: "unsupported", reason: "OpenCode can't take an urgent message mid-turn" };
          }
          if (s.stopping || turn.hasEnded() || live.conn.closed) return { status: "no_turn" };
          const step = reader.steps;
          const reply = await live.conn
            .request<Record<string, unknown> | null>("_session/steering", {
              sessionId: live.acpSessionId,
              prompt: messages.map((m) => ({ type: "text", text: m.text })),
            })
            .catch(() => null);
          if (reply?.outcome !== "injected") return { status: "no_turn" };
          const uuids = messages.map((m) => m.uuid);
          steered.push({ uuids, step });
          return { status: "accepted", accepted: uuids };
        },
      });
    }
    const stopped = () => {
      if (s.stopping === "canceled") fail("canceled", "The turn was canceled.");
      else if (s.stopping === "breach") {
        fail("tools_not_locked", reader.breach ?? "OpenCode called a tool of its own, so the turn stopped.");
      } else if (s.stopping === "silence") {
        const span =
          silenceMs >= 60_000 ? `${Math.round(silenceMs / 60_000)} minutes` : `${Math.round(silenceMs / 1000)} seconds`;
        fail(
          "opencode_failed",
          `OpenCode said nothing for ${span} with no tool running (its provider may be refusing it, as at a usage limit), so the turn stopped.`,
          true,
        );
      }
      return s.stopping !== null;
    };
    try {
      if (input.model && live.model !== input.model && !stopped()) {
        await within(
          live.conn.request("session/set_config_option", {
            sessionId: live.acpSessionId,
            configId: "model",
            value: input.model,
          }),
          SETUP_TIMEOUT_MS,
          "OpenCode took too long to switch models",
        );
        live.model = input.model;
      }
      if (stopped()) return { drop: true };
      const fresh = !live.hasContext;
      const answer = await live.conn
        .request<Record<string, unknown> | null>("session/prompt", {
          sessionId: live.acpSessionId,
          prompt: [{ type: "text", text: opencodePrompt(input.system, input.prompt, fresh) }],
        })
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      if (answer.ok) {
        admit();
        for (const event of reader.usage(answer.result?.usage, input.model)) turn.emit(event);
      }
      if (stopped()) return { drop: true };
      if (!answer.ok) {
        if (live.exited) return { died: true, drop: true };
        const problem = acpProblem(answer.error);
        if (problem.auth) fail("not_logged_in", problem.message, true);
        else for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) turn.emit(event);
        return { drop: true };
      }
      const stopReason = str(answer.result?.stopReason);
      if (stopReason === "cancelled") {
        fail(
          "opencode_failed",
          s.refusedAsk
            ? `OpenCode asked for permission to ${s.refusedAsk}, which this agent may not do here, so the turn stopped.`
            : "OpenCode stopped the turn by itself.",
          true,
        );
        return { drop: true };
      }
      const text = reader.answer || reader.streamed;
      if (stopReason === "refusal" && !text.trim()) {
        fail("model_refused", "The model refused to answer.");
        return {};
      }
      readSteered(true);
      turn.emit({ type: "done", text, session: { id: input.sessionId }, timings: turn.timings() });
      return {};
    } catch (err) {
      if (stopped()) return { drop: true };
      if (live.exited) return { died: true, drop: true };
      const problem = acpProblem(err);
      for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) turn.emit(event);
      return { drop: true };
    } finally {
      liveTurns.delete(input.runId);
      clearInterval(silence);
      clearTimeout(s.killTimer);
      opts.signal.removeEventListener("abort", onAbort);
      live.conn.setHandlers({
        onRequest(method) {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        },
      });
      live.busy = false;
      live.lastUsed = Date.now();
      if (live.bridge && this.opts.runs.has(live.id)) this.opts.runs.set(live.id, live.bridge);
      if (this.live.get(live.key) === live && !live.exited) this.armIdle(live);
      this.trim(live.agentId);
    }
  }

  private armIdle(live: OpencodeLive) {
    live.idleSince = awakeClock.read();
    this.checkIdle(live, this.opts.idleMs ?? CODEX_APP_IDLE_MS);
  }

  private checkIdle(live: OpencodeLive, waitMs: number) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      live.idleTimer = null;
      if (live.busy) return;
      const left = (this.opts.idleMs ?? CODEX_APP_IDLE_MS) - (awakeClock.read() - live.idleSince);
      if (left > 0) return this.checkIdle(live, left);
      this.drop(live);
    }, waitMs);
    live.idleTimer.unref?.();
  }

  private get max() {
    return this.opts.maxProcesses ?? CODEX_APP_MAX_PROCESSES;
  }

  private alive(agentId: string) {
    return [...this.live.values()].filter((l) => l.agentId === agentId && !l.exited).length;
  }

  private lruIdle(agentId: string): OpencodeLive | undefined {
    let lru: OpencodeLive | undefined;
    for (const l of this.live.values()) {
      if (l.busy || l.agentId !== agentId) continue;
      if (!lru || l.lastUsed < lru.lastUsed) lru = l;
    }
    return lru;
  }

  private trim(agentId: string) {
    while (this.alive(agentId) > this.max) {
      const l = this.lruIdle(agentId);
      if (!l) return;
      this.drop(l);
    }
  }

  private drop(live: OpencodeLive) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (this.live.get(live.key) === live) this.live.delete(live.key);
    this.opts.runs.delete(live.id);
    this.relay.forget(live.id);
    live.bridge = null;
    live.conn.close();
    live.child.stdin?.end();
    killTree(live.child, "SIGTERM");
    live.release?.();
    live.release = undefined;
  }

  /** System mode: a pooled process on an account its agent no longer thinks with closes (a busy one stays until it idles out). */
  keepAccount(account: string | null, also: readonly string[] = []) {
    const keep = new Set([...(account ? [account] : []), ...also]);
    for (const l of [...this.live.values()]) if (!l.busy && l.account !== null && !keep.has(l.account)) this.drop(l);
  }

  close() {
    this.closed = true;
    for (const l of [...this.live.values()]) this.drop(l);
    this.relay.close();
  }
}

/** What the runner's `brain.turn` handler hands the OpenCode branch. */
export interface OpencodeBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  /** The server this computer is paired with (`HandlerContext.server`): where a proxied turn thinks. */
  server?: string;
  sessions?: CodexThreads;
  pool?: OpencodeServers;
  bin?: string;
  grants?: string[];
  accounts?: AccountFolders;
  grant?: AccountGrant;
  spawn?: Spawn;
}

const sessionStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "opencode"`: the turn's folder in the agent's own folder, its secrets, then the turn. */
export async function handleOpencodeBrainTurn(
  ctx: OpencodeBrainContext,
  req: OpencodeBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "OpenCode is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  if (typeof req.model === "string" && req.model && !/^[\w.-]{1,40}\/[\w.:[\]-]{1,79}$/.test(req.model)) {
    throw new RunnerError("bad_request", "model is provider/model");
  }
  // The server's model proxy (ADR 9007): its one model, at the server this computer is paired with, never a key.
  const proxy = req.proxy === true;
  if (proxy && (req.model !== PROXY_MODEL || !ctx.server)) {
    throw new RunnerError("bad_request", `a proxied turn thinks with ${PROXY_MODEL}, at the paired server`);
  }
  const freeTier = !proxy && req.freeTier === true && !req.account;
  if (freeTier && typeof req.model === "string" && req.model && !req.model.startsWith("opencode/")) {
    throw new RunnerError("bad_request", "OpenCode's free tier thinks only with OpenCode's own models");
  }
  const chat = req.permissions?.mode === "chat";
  let cwd = ctx.folder;
  // A `chat` turn starts in the agent's own folder, whatever the request names.
  if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
  let account: OpencodeTurnInput["account"];
  let release: (() => void) | undefined;
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
    const signIn = await accountSignIn(ctx.accounts, "opencode", accountId, ctx.grant);
    if (signIn === "signed_out") {
      scope.emit({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
      return;
    }
    if (signIn === "missing") {
      scope.emit({
        type: "error",
        code: "account_missing",
        message: ACCOUNT_MISSING_MESSAGE.opencode,
        retryable: false,
      });
      return;
    }
    release = signIn.release;
    const planKey = signIn.planKey ?? (await planKeyOf(signIn.home)) ?? undefined;
    const key = planKey ? undefined : await opencodeKeyOf(signIn.home);
    account = { id: accountId, home: signIn.home, ...(key ? { key } : {}), ...(planKey ? { planKey } : {}) };
  }
  try {
    const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
    const file = opencodeSessionsFile(ctx.runnerHome);
    const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
    sessionStores.set(file, sessions);
    const turnInput: OpencodeTurnInput = {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
      ...(account ? { account } : {}),
      profile: codexProfileOf(req),
      ...(freeTier ? { freeTier } : {}),
      ...(proxy && ctx.server ? { proxy: { baseUrl: `${ctx.server.replace(/\/+$/, "")}/api/model-proxy/v1` } } : {}),
      ...(chat ? { chat } : {}),
      ...(req.keepAlive === false ? { keepAlive: false } : {}),
      folder: ctx.folder,
      agentId: String(req.agent.id),
    };
    const turnOpts: OpencodeTurnOptions = {
      sessions,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
    };
    if (ctx.pool && !turnInput.mcp.url) {
      const owned = release;
      release = undefined;
      await ctx.pool.turn(turnInput, turnOpts, owned);
      return;
    }
    await runOpencodeTurn(turnInput, turnOpts);
  } finally {
    release?.();
  }
}

/** `brain.warm` with `kind: "opencode"`: best-effort pre-spawn of a pooled `opencode acp` process. */
export async function handleOpencodeBrainWarm(
  ctx: OpencodeBrainContext,
  req: BrainWarmRequest & { agent?: AgentScope },
): Promise<BrainWarmReply> {
  const no: BrainWarmReply = { open: false, started: false };
  if (!ctx.exec || !ctx.pool || !req.agent) return no;
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) return no;
  if (req.permissions?.mode === "chat" || (req as { proxy?: unknown }).proxy === true) return no;
  if (typeof req.model === "string" && req.model && !/^[\w.-]{1,40}\/[\w.:[\]-]{1,79}$/.test(req.model)) return no;
  const freeTier = req.freeTier === true && !req.account;
  if (freeTier && typeof req.model === "string" && req.model && !req.model.startsWith("opencode/")) return no;
  let cwd = ctx.folder;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd).catch(() => null);
    if (!resolved?.exists) return no;
    cwd = resolved.abs;
  }
  let account: OpencodeTurnInput["account"];
  let release: (() => void) | undefined;
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) return no;
    const signIn = await accountSignIn(ctx.accounts, "opencode", accountId, ctx.grant).catch(() => null);
    if (!signIn || signIn === "signed_out" || signIn === "missing") return no;
    release = signIn.release;
    const planKey = signIn.planKey ?? (await planKeyOf(signIn.home).catch(() => null)) ?? undefined;
    const key = planKey ? undefined : await opencodeKeyOf(signIn.home).catch(() => undefined);
    account = { id: accountId, home: signIn.home, ...(key ? { key } : {}), ...(planKey ? { planKey } : {}) };
  }
  try {
    const secrets = await agentSecrets(ctx.secretsDir, req.agent).catch(() => null);
    const file = opencodeSessionsFile(ctx.runnerHome);
    const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
    sessionStores.set(file, sessions);
    const owned = release;
    release = undefined;
    return await ctx.pool.prewarm(
      {
        sessionId: req.session.id,
        cwd,
        folder: ctx.folder,
        ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
        ...(account ? { account } : {}),
        profile: codexProfileOf(req),
        ...(freeTier ? { freeTier } : {}),
        agentId: String(req.agent.id),
      },
      {
        sessions,
        runnerHome: ctx.runnerHome,
        ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
        ...(secrets ? { env: secrets.env, redact: secrets.redact } : {}),
        ...(ctx.bin ? { bin: ctx.bin } : {}),
        ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
      },
      owned,
    );
  } finally {
    release?.();
  }
}
