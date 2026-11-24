import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type {
  AgentScope,
  BrainColdCause,
  BrainEffort,
  BrainTurnTimings,
  BrainWarmReply,
  BrainWarmRequest,
} from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSignIn,
  withoutContainers,
  withoutSignIns,
} from "./accounts";
import { ACP_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION, AcpConnection, AcpError } from "./acp";
import { AGY_CHAT_AGENT, prepareAgyHome } from "./agy-home";
import { awakeClock } from "./awake";
import { LIMIT_TEXT } from "./brain";
import { type CodexBrainEvent, CodexThreads, chatFolder, codexProfileOf, codexThreadKey } from "./brain-codex";
import { CODEX_APP_IDLE_MS, CODEX_APP_MAX_PROCESSES } from "./brain-codex-app";
import { cursorPrompt } from "./brain-cursor";
import { acpProblem, OpencodeTurnReader, opencodeBridge, opencodePrompt } from "./brain-opencode";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { AGY_BIN, envValue, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, type McpTaskInfo, newMcpToken, redactDeep } from "./mcp";
import { isInside, resolveForAgent } from "./paths";
import { resetFromWords } from "./plan-usage";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Antigravity branch of `brain.turn` (protocol 44, ADR 0143): one agent turn as one run of Google's Antigravity
 * CLI (`agy -p --output-format stream-json`), its NDJSON read here: `init` (the conversation and every tool), then
 * `step_update`s (the reply's text deltas, each tool step with its call and output, per-step usage), then `result`.
 * Flags and shapes as antigravity.google/docs/cli/headless and cli/reference list them, read 2026-11-04.
 *
 * - Always an account, on Linux: its folder is the CLI's whole `HOME` (`agy-home.ts`), prepared before every turn
 *   (settings, our MCP server alone, Lodi's agent; anything an earlier turn planted removed). The run and its token
 *   reach our server through the env it inherits, so the account's turns of several agents share one config. One
 *   root keeps for all agents (protocol 58) is the agent's own folder for it instead, with a copy of root's sign-in
 *   for as long as the agent's turns on it run (a worker killed mid-turn leaves it until the agent's next one starts).
 * - The chat: `init` names the conversation; our session → that conversation lives in
 *   `<runner home>/brain/antigravity-chats.json` (per account), resumed with `--conversation`. A new chat leads its
 *   prompt with the engine's context (`cursorPrompt`); a resume that comes back as another conversation (the CLI
 *   only warns on one it doesn't know) is stopped at `init` and started again with the context.
 * - ADR 0053 §3: every turn runs with `--sandbox` (terminal commands in the CLI's sandbox: the turn's folder and temp,
 *   no network) and the account's `proceed-in-sandbox`; `work` adds `--mode accept-edits` (edits in the workspace
 *   without asking), `plan` doesn't (an edit needs an approval nobody gives in headless mode, so it is refused).
 * - `chat` (the team's right hand, ADR 0137 §4): `--agent agenteschat-chat` (no built-in tool, no commands, never a
 *   subagent), in an empty folder with none of the agent's secrets. `antigravityChatBreach` kills the turn on an
 *   `init` listing any tool but our server's, on anything before `init`, on a tool step that isn't ours and on a
 *   subagent.
 * - Our server's calls are not repeated as `tool_call`: the engine ran them. The CLI's own tools are, as what the turn
 *   tried. Usage is the plan's (`source: "plan"`): the turn's `agent_response` steps summed (`result.usage` counts
 *   the whole conversation).
 * - A failed turn exits non-zero; a model or agent failure exits 3 with an `AGY_ERROR: {…}` line on stderr (its
 *   canonical status, HTTP or gRPC code, retryability): quota and rate limits are `plan_limit`, a refused sign-in
 *   `not_logged_in`.
 * - No live steering: `-p` takes nothing mid-turn (`brain.steer` answers `unsupported`).
 */

const KILL_GRACE_MS = 5000;

/** `brain.turn` with `kind: "antigravity"`. */
export interface AntigravityBrainTurnRequest {
  runId: string;
  kind: "antigravity";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  effort?: BrainEffort;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
}

/** Where our session → conversation ids live in the runner home. */
export const antigravityChatsFile = (runnerHome: string) => path.join(runnerHome, "brain", "antigravity-chats.json");

/** The env name our bridge's run id comes through (`agentes-runner mcp` with no `--run` reads it). */
export const AGY_RUN_ENV = "AGENTES_MCP_RUN";

/**
 * A tool of our server, as the CLI may name it: `agenteschat_agentes__post_message`, `…/post_message`,
 * `mcp_agenteschat_agentes_post_message`. Anything else is the CLI's own.
 */
const OURS = new RegExp(`^(?:mcp[_.:/-]{1,2})?${CODEX_MCP_SERVER}(?:__|[_.:/-])[\\w.-]+$`);
export const isOurAgyTool = (name: unknown) => typeof name === "string" && OURS.test(name);

/**
 * A slug that names the model's own thinking level (`gemini-4-hydrogen-xhigh`): `agy` refuses `--effort` beside it
 * ("--model %s conflicts with --effort=%s", CLI 1.5.9).
 */
const LEVEL_IN_SLUG = /-(?:low|medium|high|xhigh|max)$/;

/** `--effort`: low, medium, high, xhigh, or max (agy 1.5.9+); a slug that names its level takes none. */
const agyEffort = (effort?: BrainEffort, model?: string) => (model && LEVEL_IN_SLUG.test(model) ? undefined : effort);

/** The `agy` arguments for one turn. */
export function antigravityTurnArgs(input: {
  prompt: string;
  chat?: string;
  model?: string;
  effort?: BrainEffort;
  profile?: CommandProfile;
  /** The team's right hand: our server's tools alone. */
  locked?: boolean;
  /**
   * Folders the agent may use besides the turn's (`--add-dir` each, as Claude Code's): outside the workspace, the
   * CLI's sandbox doesn't see them and headless mode refuses reading them.
   */
  addDirs?: string[];
}): string[] {
  const effort = agyEffort(input.effort, input.model);
  return [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--sandbox",
    "--disable-slash-commands",
    ...(input.locked ? ["--agent", AGY_CHAT_AGENT] : input.profile === "plan" ? [] : ["--mode", "accept-edits"]),
    ...(input.model ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(input.chat ? ["--conversation", input.chat] : []),
    ...(input.locked ? [] : (input.addDirs ?? []).flatMap((d) => ["--add-dir", d])),
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A `chat` turn's guard (protocol 44), line by line: `init` must list our server's tools alone, nothing may come
 * before it, and no step may be a tool that isn't ours or a subagent. Null when the line is fine.
 */
export function antigravityChatBreach(ev: Record<string, unknown>, sawInit: boolean): string | null {
  const stop = (why: string) => `${why}, so the turn stopped.`;
  if (ev.event === "init") {
    const tools = isRecord(ev.init) ? ev.init.tools : undefined;
    if (!Array.isArray(tools)) return "The Antigravity CLI didn't list its tools, so the turn stopped before it began.";
    const theirs = tools.filter((t) => !isOurAgyTool(t)).map((t) => String(t).slice(0, 64));
    if (theirs.length === 0) return null;
    return `The Antigravity CLI offers tools of its own here (${theirs.slice(0, 8).join(", ")}), so the turn stopped before it could use them.`;
  }
  if (!sawInit) return stop("The Antigravity CLI answered before listing its tools");
  if (ev.event !== "step_update") return null;
  const step = isRecord(ev.step_update) ? ev.step_update : {};
  if (step.subagent_info !== undefined) return stop("The Antigravity CLI started another agent");
  const info = isRecord(step.tool_info) ? step.tool_info : {};
  const name = step.tool_name ?? info.name;
  if ((step.step_type === "tool" || name !== undefined) && !isOurAgyTool(name)) {
    return stop(`The Antigravity CLI used a tool of its own (${String(name ?? "unknown").slice(0, 64)})`);
  }
  return null;
}

/** `AGY_ERROR: {…}` on stderr (CLI 1.2.x): what it says, and whether it is a limit or a refused sign-in. */
export function parseAgyError(stderr: string): { message: string; limit: boolean; auth: boolean } | null {
  const line = stderr
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("AGY_ERROR:"));
  if (!line) return null;
  let o: Record<string, unknown> = {};
  try {
    const v = JSON.parse(line.slice("AGY_ERROR:".length).trim());
    if (isRecord(v)) o = v;
  } catch {
    return { message: line.slice(0, 500), limit: false, auth: false };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const status = `${str(o.status)} ${str(o.canonical_status)} ${str(o.code)} ${str(o.http_status)}`;
  const message = (str(o.message) || str(o.error) || status.trim() || "The model call failed").slice(0, 500);
  return {
    message,
    limit: /RESOURCE_EXHAUSTED|\b429\b/i.test(status) || AGY_LIMIT.test(message),
    auth: /UNAUTHENTICATED|\b401\b/i.test(status) || AGY_AUTH.test(message),
  };
}

const AGY_LIMIT = /quota|rate.?limit|usage limit|resource.?exhausted|weekly limit|five.?hour limit|out of credits/i;
/** The CLI can't sign in (signed out, a refused token, no license). */
export const AGY_AUTH =
  /auth(?:entication)? required|not (?:authenticated|logged in|signed in)|unauthenticated|unauthori[sz]ed|\b401\b|invalid (?:token|credentials|grant)|license/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `antigravity_failed`. */
export function antigravityProblem(
  problem: string,
  o: { worked?: boolean; limit?: boolean; auth?: boolean; now?: number } = {},
): CodexBrainEvent[] {
  if (o.limit || AGY_LIMIT.test(problem) || LIMIT_TEXT.test(problem)) {
    const resetsAt = resetFromWords(problem, o.now);
    return [
      { type: "limit", ...(resetsAt ? { resetsAt } : {}) },
      { type: "error", code: "plan_limit", message: problem, retryable: true, worked: o.worked ?? false },
    ];
  }
  if (o.auth || AGY_AUTH.test(problem))
    return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "antigravity_failed", message: problem, retryable: true }];
}

const tokens = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** One usage record as ours: every input token (the CLI's input may already leave the cache out), output with thinking. */
function usageOf(u: Record<string, unknown>) {
  const input = tokens(u.input_tokens);
  const cacheRead = tokens(u.cache_read_tokens);
  return { input: input >= cacheRead ? input : input + cacheRead, output: tokens(u.output_tokens), cacheRead };
}

export interface AntigravityTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: BrainEffort;
  system: string;
  prompt: string;
  mcp: { token: string };
  /** The account: its folder is the CLI's `HOME`, its chats are its own. */
  account: { id: string; home: string };
  profile?: CommandProfile;
  /** The team's right hand (`cwd` its empty `chatFolder`): killed at a tool of the CLI's own. */
  chat?: boolean;
  /** The agent's own folder when the turn starts in a checkout, and its granted folders (`antigravityTurnArgs`). */
  addDirs?: string[];
  folder?: string;
  agentId?: string;
  keepAlive?: boolean;
}

export interface AntigravityTurnOptions {
  chats: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome?: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Streamed text holds back this many characters (the longest secret − 1). */
  redactHold?: number;
  /** Tests: the executable. */
  bin?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** Runs one Antigravity turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runAntigravityTurn(input: AntigravityTurnInput, opts: AntigravityTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  // On Windows the CLI keeps its sign-in in the one Credential Manager of the computer's user (ADR 0143).
  if ((opts.platform ?? process.platform) === "win32") {
    return fail("unsupported", "Gemini plans don't think on Windows computers yet.");
  }
  try {
    prepareAgyHome(input.account.home, opts.mcpCommand);
    if (input.chat) {
      // Nothing of the workspace's own config (`.agents/`, `.gemini/`) in Lodi's folder.
      for (const name of [".agents", ".gemini"]) rmSync(path.join(input.cwd, name), { recursive: true, force: true });
      mkdirSync(input.cwd, { recursive: true });
    }
  } catch (err) {
    return fail(
      "antigravity_failed",
      `Couldn't set up the agent's tools for the Antigravity CLI: ${(err as Error).message}`,
      true,
    );
  }
  const chatKey = codexThreadKey(input.sessionId, input.account.id);
  const base: NodeJS.ProcessEnv = {
    ...withoutContainers(input.chat ? withoutSignIns(process.env) : process.env),
    ...(opts.env ?? {}),
    [AGY_RUN_ENV]: input.runId,
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
  };
  const env = accountEnv("antigravity", input.account.home, base);
  const clean = (text: string) => (opts.redact ? opts.redact(text) : text);
  const hold = opts.redact ? (opts.redactHold ?? 0) : 0;

  // One retry, as a new chat, when the CLI doesn't have the conversation it was to resume.
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    let initMs: number | undefined;
    let firstEventMs: number | undefined;
    let firstTokenMs: number | undefined;
    const chat = opts.chats.get(chatKey);
    const args = antigravityTurnArgs({
      prompt: cursorPrompt(input.system, input.prompt, !chat),
      ...(chat ? { chat } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      profile: input.profile ?? "work",
      ...(input.chat ? { locked: true } : {}),
      ...(input.addDirs?.length ? { addDirs: input.addDirs } : {}),
    });
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? AGY_BIN, env.PATH), args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      return fail("antigravity_failed", err instanceof Error ? err.message : String(err));
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    let tail = "";
    let streamed = false;
    let worked = false;
    const flush = (text: string, whole: boolean) => {
      const out = clean(tail + text);
      const at = whole ? out.length : Math.max(0, out.length - hold);
      tail = out.slice(at);
      if (at > 0) {
        streamed = true;
        const elapsed = Date.now() - startedAt;
        firstEventMs ??= elapsed;
        firstTokenMs ??= elapsed;
        opts.emit({ type: "text_delta", text: out.slice(0, at) });
      }
    };
    let sawInit = false;
    let lost = false;
    let breach: string | null = null;
    let result: Record<string, unknown> | undefined;
    let model = input.model;
    const used = { input: 0, output: 0, cacheRead: 0, steps: 0 };
    const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
    (lines as unknown as EventEmitter).on("line", (line: string) => {
      if (breach || lost || result) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(ev)) return;
      if (input.chat) {
        breach = antigravityChatBreach(ev, sawInit);
        if (breach) {
          killTree(child, "SIGKILL");
          return;
        }
      }
      if (ev.event === "init") {
        sawInit = true;
        initMs ??= Date.now() - startedAt;
        const id = typeof ev.conversation_id === "string" ? ev.conversation_id : undefined;
        if (isRecord(ev.init) && typeof ev.init.model === "string") model = ev.init.model;
        // A resume the CLI didn't have comes back as a new conversation, without the context.
        if (chat && id && id !== chat && attempt === 0) {
          lost = true;
          killTree(child, "SIGKILL");
          return;
        }
        if (id) opts.chats.set(chatKey, id);
        return;
      }
      if (ev.event === "result") {
        result = isRecord(ev.result) ? ev.result : {};
        return;
      }
      if (ev.event !== "step_update" || !isRecord(ev.step_update)) return;
      const step = ev.step_update;
      if (step.step_type === "agent_response") {
        if (typeof step.text_delta === "string" && step.text_delta) flush(step.text_delta, false);
        if (step.state === "DONE" && isRecord(step.usage)) {
          const u = usageOf(step.usage);
          used.input += u.input;
          used.output += u.output;
          used.cacheRead += u.cacheRead;
          used.steps++;
        }
        return;
      }
      const info = isRecord(step.tool_info) ? step.tool_info : null;
      if (step.step_type !== "tool" || step.state !== "DONE" || !info) return;
      const name = typeof step.tool_name === "string" ? step.tool_name : String(info.name ?? "tool");
      worked = true;
      // Our bridge's calls: the engine ran them.
      if (isOurAgyTool(name)) return;
      flush("", true);
      const error = isRecord(info.error) ? info.error : null;
      const output = error ? String(error.message ?? error.type ?? "failed") : String(info.output ?? "");
      firstEventMs ??= Date.now() - startedAt;
      opts.emit({
        type: "tool_call",
        id: `${String(step.conversation_id ?? "agy")}:${String(step.step_index ?? used.steps)}`,
        name,
        input: redactDeep(info.parameters ?? {}, clean),
        executed: { content: clean(output.slice(0, 20_000)), ...(error ? { isError: true } : {}) },
      });
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const proc = child as unknown as EventEmitter;
      proc.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          resolve({ code: null, error });
        }
      });
      proc.on("close", (code: number | null) => {
        if (!settled) {
          settled = true;
          resolve({ code });
        }
      });
    });
    opts.signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    lines.close();
    if (opts.signal.aborted) return fail("canceled", "The turn was canceled.");
    if (breach) return fail("tools_not_locked", breach);
    if (exit.error) {
      const missing = (exit.error as NodeJS.ErrnoException).code === "ENOENT";
      return fail(
        missing ? "antigravity_missing" : "antigravity_failed",
        missing ? "The Antigravity CLI, Google's, is not installed on this computer." : exit.error.message,
        true,
      );
    }
    if (chat && attempt === 0 && (lost || (!sawInit && /conversation[^\n]*not found/i.test(stderr)))) {
      opts.chats.delete(chatKey);
      continue;
    }
    flush("", true);
    const r = result ?? {};
    const u = used.steps === 0 && !chat && isRecord(r.usage) ? usageOf(r.usage) : used;
    if (u.input || u.output) {
      opts.emit({
        type: "usage",
        input: u.input,
        output: u.output,
        source: "plan",
        ...(model ? { model } : {}),
        ...(u.cacheRead ? { cacheRead: u.cacheRead } : {}),
      });
    }
    const response = typeof r.response === "string" ? r.response : "";
    if (r.status === "SUCCESS" && exit.code === 0) {
      const text = clean(response.trimEnd());
      if (text && !streamed) {
        const elapsed = Date.now() - startedAt;
        firstEventMs ??= elapsed;
        firstTokenMs ??= elapsed;
        opts.emit({ type: "text_delta", text });
      }
      firstEventMs ??= Date.now() - startedAt;
      opts.emit({
        type: "done",
        text,
        session: { id: input.sessionId },
        timings: {
          warm: false,
          cold: chat ? "restart" : "new_session",
          ...(initMs !== undefined ? { initMs } : {}),
          ...(firstEventMs !== undefined ? { firstEventMs } : {}),
          ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
        },
      });
      return;
    }
    // The CLI replays a conversation's last error on every resume (a quota one included, with its old reset):
    // the next turn opens a new conversation, with the context the engine sends anyway.
    if (chat) opts.chats.delete(chatKey);
    const agyError = parseAgyError(stderr);
    const why =
      agyError?.message ??
      (typeof r.error === "string" && r.error
        ? r.error
        : r.finished_reason === "print_timeout"
          ? "The Antigravity CLI ran out of time"
          : exit.code === 0
            ? "The Antigravity CLI ended without finishing the turn"
            : `The Antigravity CLI exited with code ${exit.code ?? "?"}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
    for (const event of antigravityProblem(clean(why), {
      worked: worked || streamed,
      limit: agyError?.limit ?? false,
      auth: agyError?.auth ?? false,
      ...(opts.now ? { now: opts.now() } : {}),
    }))
      opts.emit(event);
    return;
  }
}

/** What the runner's `brain.turn` handler hands the Antigravity branch. */
const SETUP_TIMEOUT_MS = 120_000;
const STOP_WAIT_MS = 8000;
const agyStr = (v: unknown) => (typeof v === "string" ? v : "");

interface AgyLive {
  key: string;
  id: string;
  agentId: string;
  account: string;
  chatKey: string;
  acpSessionId: string;
  hasContext: boolean;
  model: string | undefined;
  effort: string | undefined;
  mode: string | undefined;
  modelOptions: Set<string>;
  thoughtOptions: Set<string>;
  child: ChildProcess;
  conn: AcpConnection;
  exited: boolean;
  sig: string;
  busy: boolean;
  lastUsed: number;
  idleSince: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  bridge: McpTaskInfo | null;
  release?: () => void;
}

export interface AntigravityServersOptions {
  runs: Map<string, McpTaskInfo>;
  idleMs?: number;
  maxProcesses?: number;
  spawn?: Spawn;
  log?: (line: string) => void;
}

function optionValues(configOpts: Record<string, unknown>[], id: string): { current?: string; values: Set<string> } {
  const opt = configOpts.find((o) => o.id === id);
  const current = opt ? agyStr(opt.currentValue) || undefined : undefined;
  const raw = Array.isArray(opt?.options) ? opt.options : [];
  const values = new Set<string>();
  for (const entry of raw) {
    if (isRecord(entry) && typeof entry.value === "string") values.add(entry.value);
  }
  return { ...(current ? { current } : {}), values };
}

function resolveAgyConfig(
  model: string | undefined,
  effort: BrainEffort | undefined,
  modelOptions: Set<string>,
  thoughtOptions: Set<string>,
): { model?: string; effort?: string } {
  let pickedModel = model;
  let pickedEffort: string | undefined = agyEffort(effort, model);
  if (pickedModel && modelOptions.size > 0 && !modelOptions.has(pickedModel)) {
    const m = LEVEL_IN_SLUG.exec(pickedModel);
    if (m) {
      const base = pickedModel.slice(0, m.index);
      const level = m[0].slice(1);
      if (modelOptions.has(base)) {
        pickedModel = base;
        pickedEffort = thoughtOptions.has(level)
          ? level
          : level === "max" && thoughtOptions.has("xhigh")
            ? "xhigh"
            : undefined;
      }
    }
  } else if (pickedModel && !pickedEffort) {
    const m = LEVEL_IN_SLUG.exec(pickedModel);
    if (m && (modelOptions.size === 0 || modelOptions.has(pickedModel.slice(0, m.index)))) {
      const base = pickedModel.slice(0, m.index);
      const level = m[0].slice(1);
      if (thoughtOptions.size > 0) {
        pickedModel = base;
        pickedEffort = thoughtOptions.has(level)
          ? level
          : level === "max" && thoughtOptions.has("xhigh")
            ? "xhigh"
            : undefined;
      }
    }
  }
  if (pickedEffort && thoughtOptions.size > 0 && !thoughtOptions.has(pickedEffort)) {
    if (pickedEffort === "max" && thoughtOptions.has("xhigh")) pickedEffort = "xhigh";
    else pickedEffort = undefined;
  }
  return { ...(pickedModel ? { model: pickedModel } : {}), ...(pickedEffort ? { effort: pickedEffort } : {}) };
}

/** Long-lived `agy acp` processes per `(agent, session, account)`, owning sign-in leases until dropped. */
export class AntigravityServers {
  private readonly live = new Map<string, AgyLive>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cwds = new Map<string, string>();
  private closed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: AntigravityServersOptions) {
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

  private signature(input: AntigravityTurnInput, opts: AntigravityTurnOptions) {
    return JSON.stringify({
      cwd: input.cwd,
      account: input.account.home,
      addDirs: input.addDirs ?? [],
      bin: opts.bin ?? AGY_BIN,
      mcp: opts.mcpCommand ?? null,
      socket: opts.socketPath ?? null,
      env: opts.env ?? {},
    });
  }

  async prewarm(
    input: Omit<AntigravityTurnInput, "runId" | "prompt" | "system" | "mcp">,
    opts: Omit<AntigravityTurnOptions, "emit" | "signal">,
    release?: () => void,
  ): Promise<BrainWarmReply> {
    const no: BrainWarmReply = { open: false, started: false };
    let owned = release;
    try {
      if (this.closed || !input.agentId || input.chat || (opts.platform ?? process.platform) === "win32") {
        return no;
      }
      const last = input.folder && input.cwd === input.folder ? this.cwds.get(input.agentId) : undefined;
      const roots = input.folder ? [input.folder, ...(input.addDirs ?? [])] : [];
      const cwd = last && roots.some((r) => isInside(r, last)) && existsSync(last) ? last : input.cwd;
      const chatKey = codexThreadKey(input.sessionId, input.account.id);
      const key = `${input.agentId}:${chatKey}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const run = prev
        .catch(() => undefined)
        .then(async (): Promise<BrainWarmReply> => {
          if (this.closed) return no;
          const dummyInput: AntigravityTurnInput = {
            ...input,
            cwd,
            runId: "warm",
            system: "",
            prompt: "",
            mcp: { token: "" },
          };
          const dummyOpts: AntigravityTurnOptions = {
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
          const started = await this.start(key, chatKey, sig, dummyInput, dummyOpts, owned);
          if (!started) return no;
          owned = undefined;
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
      owned?.();
    }
  }

  async turn(input: AntigravityTurnInput, opts: AntigravityTurnOptions, release?: () => void): Promise<void> {
    let owned = release;
    try {
      if (this.closed || input.chat || !input.agentId || (opts.platform ?? process.platform) === "win32") {
        await runAntigravityTurn(input, opts);
        return;
      }
      this.cwds.set(input.agentId, input.cwd);
      const chatKey = codexThreadKey(input.sessionId, input.account.id);
      const key = `${input.agentId}:${chatKey}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const run = prev
        .catch(() => undefined)
        .then(async () => {
          const res = await this.runPooled(key, chatKey, input, opts, owned);
          if (res.consumedRelease) owned = undefined;
          return res.handled;
        });
      this.chains.set(key, run);
      let handled = false;
      try {
        handled = await run;
      } catch (err) {
        this.log(`antigravity acp turn failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (this.chains.get(key) === run) this.chains.delete(key);
      }
      if (!handled) await runAntigravityTurn(input, opts);
    } finally {
      owned?.();
    }
  }

  private async runPooled(
    key: string,
    chatKey: string,
    input: AntigravityTurnInput,
    opts: AntigravityTurnOptions,
    release?: () => void,
  ): Promise<{ handled: boolean; consumedRelease: boolean }> {
    if (opts.signal.aborted) {
      opts.emit({ type: "error", code: "canceled", message: "The turn was canceled." });
      return { handled: true, consumedRelease: false };
    }
    const startedAt = Date.now();
    let warm = false;
    let cold: BrainColdCause | undefined;
    let initMs: number | undefined;
    let firstEventMs: number | undefined;
    let firstTokenMs: number | undefined;
    let emitted = false;
    let ended = false;
    let consumedRelease = false;
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
      cold ??= opts.chats.get(chatKey) ? "restart" : "new_session";
      const agent = input.agentId ?? "";
      const lru = this.alive(agent) >= this.max ? this.lruIdle(agent) : undefined;
      if (lru) this.drop(lru);
      const started = await this.start(key, chatKey, sig, input, opts, release);
      if (!started) return { handled: false, consumedRelease: false };
      consumedRelease = true;
      initMs = Date.now() - startedAt;
      live = started;
    }
    const outcome = await this.onLive(live, input, opts, {
      emit,
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
      return { handled: false, consumedRelease };
    }
    if (outcome.drop || input.keepAlive === false) this.drop(live);
    return { handled: true, consumedRelease };
  }

  private async start(
    key: string,
    chatKey: string,
    sig: string,
    input: AntigravityTurnInput,
    opts: AntigravityTurnOptions,
    release?: () => void,
  ): Promise<AgyLive | null> {
    try {
      prepareAgyHome(input.account.home, opts.mcpCommand);
    } catch {
      return null;
    }
    const base: NodeJS.ProcessEnv = {
      ...withoutContainers(process.env),
      ...(opts.env ?? {}),
    };
    const env = accountEnv("antigravity", input.account.home, base);
    const args = ["acp", "--sandbox", ...(input.addDirs?.length ? input.addDirs.flatMap((d) => ["--add-dir", d]) : [])];
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? opts.spawn ?? spawn)(
        resolveCommand(opts.bin ?? AGY_BIN, envValue(env, "PATH")),
        args,
        {
          cwd: input.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        },
      );
    } catch {
      return null;
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
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
    const proc = child as unknown as EventEmitter;
    proc.on("error", (err: Error) => {
      exited = true;
      conn.close(err);
    });
    proc.on("close", (code: number | null) => {
      exited = true;
      conn.close(
        new Error(
          `Antigravity exited with code ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
        ),
      );
    });
    const within = <T>(p: Promise<T>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), SETUP_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const id = randomUUID();
    const token = newMcpToken();
    try {
      const init = await within(
        conn.request<Record<string, unknown> | null>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agentes-runner", version: "1" },
        }),
        "Antigravity ACP initialize timed out",
      );
      const caps = isRecord(init?.agentCapabilities) ? init.agentCapabilities : {};
      const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
      const bridgeServer = opencodeBridge({
        runId: id,
        token,
        ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
        ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
        runnerHome: opts.runnerHome ?? "",
      });
      const stored = opts.chats.get(chatKey);
      const resume = isRecord(sessionCaps.resume)
        ? "session/resume"
        : caps.loadSession === true
          ? "session/load"
          : null;
      let acpSessionId: string | null = null;
      let hasContext = false;
      let opened: Record<string, unknown> | null = null;
      if (stored && resume) {
        opened = await within(
          conn.request<Record<string, unknown> | null>(resume, {
            sessionId: stored,
            cwd: input.cwd,
            mcpServers: [bridgeServer],
          }),
          "Antigravity ACP resume timed out",
        ).then(
          (r) => r ?? {},
          () => null,
        );
        if (opened) {
          acpSessionId = stored;
          hasContext = true;
        } else {
          opts.chats.delete(chatKey);
        }
      } else if (stored) {
        opts.chats.delete(chatKey);
      }
      if (!acpSessionId) {
        opened = await within(
          conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridgeServer] }),
          "Antigravity ACP session/new timed out",
        );
        acpSessionId = agyStr(opened?.sessionId) || null;
        if (!acpSessionId) throw new Error("Antigravity didn't start a session");
      }
      const configOpts = Array.isArray(opened?.configOptions) ? opened.configOptions.filter(isRecord) : [];
      const modelOpt = optionValues(configOpts, "model");
      const thoughtOpt = optionValues(configOpts, "thought_level");
      const modeOpt = optionValues(configOpts, "mode");
      const wantMode = input.profile === "plan" ? "plan" : "accept-edits";
      if (modeOpt.current !== wantMode && (!modeOpt.values.size || modeOpt.values.has(wantMode))) {
        await within(
          conn.request("session/set_config_option", { sessionId: acpSessionId, configId: "mode", value: wantMode }),
          "Antigravity ACP set mode timed out",
        );
        modeOpt.current = wantMode;
      }
      const resolved = resolveAgyConfig(input.model, input.effort, modelOpt.values, thoughtOpt.values);
      if (resolved.model && modelOpt.current !== resolved.model) {
        await within(
          conn.request("session/set_config_option", {
            sessionId: acpSessionId,
            configId: "model",
            value: resolved.model,
          }),
          "Antigravity ACP set model timed out",
        );
        modelOpt.current = resolved.model;
      }
      if (resolved.effort && thoughtOpt.current !== resolved.effort) {
        await within(
          conn.request("session/set_config_option", {
            sessionId: acpSessionId,
            configId: "thought_level",
            value: resolved.effort,
          }),
          "Antigravity ACP set effort timed out",
        );
        thoughtOpt.current = resolved.effort;
      }
      if (this.closed || exited) {
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
      const live: AgyLive = {
        key,
        id,
        agentId: input.agentId ?? "",
        account: input.account.id,
        chatKey,
        acpSessionId,
        hasContext,
        model: modelOpt.current,
        effort: thoughtOpt.current,
        mode: modeOpt.current,
        modelOptions: modelOpt.values,
        thoughtOptions: thoughtOpt.values,
        child,
        conn,
        exited: false,
        sig,
        busy: false,
        lastUsed: Date.now(),
        idleSince: awakeClock.read(),
        idleTimer: null,
        bridge,
        ...(release ? { release } : {}),
      };
      proc.on("close", () => {
        live.exited = true;
        if (!live.busy) this.drop(live);
      });
      this.live.set(key, live);
      return live;
    } catch {
      conn.close();
      killTree(child, "SIGTERM");
      return null;
    }
  }

  private async onLive(
    live: AgyLive,
    input: AntigravityTurnInput,
    opts: AntigravityTurnOptions,
    turn: { emit: (e: CodexBrainEvent) => void; timings: () => BrainTurnTimings },
  ): Promise<{ died?: boolean; drop?: boolean }> {
    live.busy = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    const clean = (text: string) => (opts.redact ? opts.redact(text) : text);
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
        ...(opts.redact ? { redact: opts.redact } : {}),
      });
    }
    const reader = new OpencodeTurnReader({ isBridgeTool: isOurAgyTool, redact: clean });
    const s = { stopping: false, killTimer: undefined as ReturnType<typeof setTimeout> | undefined };
    const admit = () => {
      if (live.hasContext) return;
      live.hasContext = true;
      opts.chats.set(live.chatKey, live.acpSessionId);
    };
    const onAbort = () => {
      if (s.stopping) return;
      s.stopping = true;
      live.conn.notify("session/cancel", { sessionId: live.acpSessionId });
      s.killTimer = setTimeout(() => killTree(live.child, "SIGKILL"), STOP_WAIT_MS);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    live.conn.setHandlers({
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== live.acpSessionId) return;
        admit();
        for (const event of reader.update(params.update)) turn.emit(event);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        const p = isRecord(params) ? params : {};
        const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
        const reject = options.find((o) => agyStr(o.kind).startsWith("reject"));
        return reject
          ? { outcome: { outcome: "selected", optionId: agyStr(reject.optionId) } }
          : { outcome: { outcome: "cancelled" } };
      },
    });
    const setCfg = async (configId: string, value: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId, value }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Antigravity ${configId} switch timed out`)), SETUP_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    try {
      const wantMode = input.profile === "plan" ? "plan" : "accept-edits";
      if (live.mode !== wantMode && !s.stopping) {
        await setCfg("mode", wantMode);
        live.mode = wantMode;
      }
      const resolved = resolveAgyConfig(input.model, input.effort, live.modelOptions, live.thoughtOptions);
      if (resolved.model && live.model !== resolved.model && !s.stopping) {
        await setCfg("model", resolved.model);
        live.model = resolved.model;
      }
      if (resolved.effort && live.effort !== resolved.effort && !s.stopping) {
        await setCfg("thought_level", resolved.effort);
        live.effort = resolved.effort;
      }
      if (s.stopping) {
        turn.emit({ type: "error", code: "canceled", message: "The turn was canceled." });
        return { drop: true };
      }
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
      if (s.stopping) {
        turn.emit({ type: "error", code: "canceled", message: "The turn was canceled." });
        return { drop: true };
      }
      if (!answer.ok) {
        if (live.exited) return { died: true, drop: true };
        const problem = acpProblem(answer.error);
        for (const ev of antigravityProblem(clean(problem.message), {
          worked: reader.worked || reader.streamed.length > 0,
          auth: problem.auth,
          ...(opts.now ? { now: opts.now() } : {}),
        }))
          turn.emit(ev);
        return { drop: true };
      }
      const stopReason = agyStr(answer.result?.stopReason);
      if (stopReason === "refusal" && !(reader.answer || reader.streamed).trim()) {
        turn.emit({ type: "error", code: "antigravity_failed", message: "The model refused to answer." });
        return {};
      }
      const text = clean((reader.answer || reader.streamed).trimEnd());
      turn.emit({ type: "done", text, session: { id: input.sessionId }, timings: turn.timings() });
      return {};
    } catch (err) {
      if (s.stopping) {
        turn.emit({ type: "error", code: "canceled", message: "The turn was canceled." });
        return { drop: true };
      }
      if (live.exited) return { died: true, drop: true };
      const problem = acpProblem(err);
      for (const ev of antigravityProblem(clean(problem.message), {
        worked: reader.worked || reader.streamed.length > 0,
        auth: problem.auth,
        ...(opts.now ? { now: opts.now() } : {}),
      }))
        turn.emit(ev);
      return { drop: true };
    } finally {
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

  private armIdle(live: AgyLive) {
    live.idleSince = awakeClock.read();
    this.checkIdle(live, this.opts.idleMs ?? CODEX_APP_IDLE_MS);
  }

  private checkIdle(live: AgyLive, waitMs: number) {
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

  private lruIdle(agentId: string): AgyLive | undefined {
    let lru: AgyLive | undefined;
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

  private drop(live: AgyLive) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (this.live.get(live.key) === live) this.live.delete(live.key);
    this.opts.runs.delete(live.id);
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
  }
}

/** What the runner's `brain.turn` handler hands the Antigravity branch. */
export interface AntigravityBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  chats?: CodexThreads;
  pool?: AntigravityServers;
  bin?: string;
  grants?: string[];
  accounts?: AccountFolders;
  /** In a worker, a sign-in root keeps for all agents (protocol 58): the copy this turn gets (`AccountManager.grant`). */
  grant?: AccountGrant;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
}

const chatStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "antigravity"`: the turn's folder in the agent's own folder, its account and secrets, the turn. */
export async function handleAntigravityBrainTurn(
  ctx: AntigravityBrainContext,
  req: AntigravityBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "The Antigravity CLI is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  // ADR 0041: the account's folder or nothing (the computer's own sign-in would need our bridge in its config).
  const accountId: unknown = req.account;
  if (accountId === undefined || accountId === null || accountId === "") {
    scope.emit({
      type: "error",
      code: "not_logged_in",
      message: "Gemini thinks only with a Gemini account connected for the agent. Connect one on the agent's page.",
      retryable: false,
    });
    return;
  }
  if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
  let signIn: Awaited<ReturnType<typeof accountSignIn>>;
  try {
    signIn = await accountSignIn(ctx.accounts, "antigravity", accountId, ctx.grant);
  } catch (err) {
    scope.emit({
      type: "error",
      code: "antigravity_failed",
      message: `This computer couldn't hand the agent its Gemini sign-in (${(err as Error).message}). Try again.`,
      retryable: true,
    });
    return;
  }
  if (signIn === "signed_out") {
    scope.emit({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
    return;
  }
  if (signIn === "missing") {
    scope.emit({
      type: "error",
      code: "account_missing",
      message: ACCOUNT_MISSING_MESSAGE.antigravity,
      retryable: false,
    });
    return;
  }
  let release: (() => void) | undefined = signIn.release;
  try {
    // A `chat` turn starts in an empty folder of its own, whatever the request names.
    const chat = req.permissions?.mode === "chat";
    const folder = chat ? chatFolder(ctx.runnerHome, String(req.agent.id)) : ctx.folder;
    let cwd = folder;
    if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveForAgent(folder, ctx.grants, req.cwd);
      if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
      cwd = resolved.abs;
    }
    const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
    const file = antigravityChatsFile(ctx.runnerHome);
    const chats = ctx.chats ?? chatStores.get(file) ?? new CodexThreads(file);
    chatStores.set(file, chats);
    const turnInput: AntigravityTurnInput = {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      folder,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token },
      account: { id: accountId, home: signIn.home },
      profile: codexProfileOf(req),
      ...(req.keepAlive === false ? { keepAlive: false } : {}),
      ...(chat
        ? { chat }
        : {
            addDirs: [...(cwd !== folder ? [folder] : []), ...(ctx.grants ?? []).filter((g) => !isInside(g, cwd))],
          }),
    };
    const turnOpts: AntigravityTurnOptions = {
      chats,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact, redactHold: secrets.hold } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
      ...(ctx.platform ? { platform: ctx.platform } : {}),
    };
    if (ctx.pool && !chat) {
      const owned = release;
      release = undefined;
      await ctx.pool.turn(turnInput, turnOpts, owned);
      return;
    }
    await runAntigravityTurn(turnInput, turnOpts);
  } finally {
    release?.();
  }
}

/** `brain.warm` with `kind: "antigravity"`: best-effort pre-spawn of a pooled `agy acp` process. */
export async function handleAntigravityBrainWarm(
  ctx: AntigravityBrainContext,
  req: BrainWarmRequest & { agent?: AgentScope },
): Promise<BrainWarmReply> {
  const no: BrainWarmReply = { open: false, started: false };
  if (!ctx.exec || !ctx.pool || !req.agent) return no;
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) return no;
  if (req.permissions?.mode === "chat") return no;
  const accountId: unknown = req.account;
  if (typeof accountId !== "string" || !accountId || !isAccountId(accountId)) return no;
  const signIn = await accountSignIn(ctx.accounts, "antigravity", accountId, ctx.grant).catch(() => null);
  if (!signIn || signIn === "signed_out" || signIn === "missing") return no;
  let release: (() => void) | undefined = signIn.release;
  try {
    let cwd = ctx.folder;
    if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd).catch(() => null);
      if (!resolved?.exists) return no;
      cwd = resolved.abs;
    }
    const secrets = await agentSecrets(ctx.secretsDir, req.agent).catch(() => null);
    const file = antigravityChatsFile(ctx.runnerHome);
    const chats = ctx.chats ?? chatStores.get(file) ?? new CodexThreads(file);
    chatStores.set(file, chats);
    const addDirs = [
      ...(cwd !== ctx.folder ? [ctx.folder] : []),
      ...(ctx.grants ?? []).filter((g) => !isInside(g, cwd)),
    ];
    const owned = release;
    release = undefined;
    return await ctx.pool.prewarm(
      {
        sessionId: req.session.id,
        cwd,
        folder: ctx.folder,
        ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
        account: { id: accountId, home: signIn.home },
        profile: codexProfileOf(req),
        ...(addDirs.length ? { addDirs } : {}),
        agentId: String(req.agent.id),
      },
      {
        chats,
        runnerHome: ctx.runnerHome,
        ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
        ...(secrets ? { env: secrets.env, redact: secrets.redact, redactHold: secrets.hold } : {}),
        ...(ctx.bin ? { bin: ctx.bin } : {}),
        ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
        ...(ctx.platform ? { platform: ctx.platform } : {}),
      },
      owned,
    );
  } finally {
    release?.();
  }
}
