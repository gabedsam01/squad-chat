# 9007. An agent on an API key thinks through OpenCode on a computer, over the server's model proxy

- Status: Accepted
- Date: 2026-11-24
- Builds on: ADR 0007 (provider keys stay on the server), ADR 0032 (computer brains), ADR 0132 (OpenCode), ADR 0059 (coding plans on OpenCode)
- Changes: ADR 0032 (a "model" agent may now think on a computer)
- Code: `packages/engine/src/model-proxy.ts`, `apps/server/src/routes/model-proxy.ts`, `packages/engine/src/run-tool-tokens.ts` (`verifyRunToolTokenForProxy`), `packages/engine/src/brains/select.ts` (`proxyPlanFor`, `proxyCapable`), `apps/server/runner/brain-opencode.ts`, `packages/adapters/src/machine-protocol.ts` (`MODEL_PROXY_PROTOCOL`)

## Context

Agents on a provider key (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, Z.ai, MiniMax, Command Code, a workspace's own endpoint) think inside the server's process and have only our tools. Plan agents run on a computer through a CLI and have its shell, files and git. One loop for both makes every agent work the same way, whichever way it pays for models.

## Decision

1. A model agent's turn runs on OpenCode on a connected computer when one can take it, and in the server's process, unchanged, when none can.
2. OpenCode's only provider is `squadchat`, an OpenAI-compatible endpoint at `<server>/api/model-proxy/v1`. The bearer is the turn's run tool token (ADR 0032), so the computer is trusted only with a token that dies with the run. No provider key is ever sent to a computer.
3. The proxy (`POST /chat/completions`, `GET /models`) turns the OpenAI request into a Model Gateway call. The model OpenCode names is ignored: the call uses the agent's own model for that run (Automático's pick from the run's transcript) and its effort. Budget is reserved before the call, tokens and cost are recorded with org, agent, run and person, exactly as the in-process path does. Text streams as it arrives; tool calls and usage come at the end of the call, because the gateway returns them whole.
4. Errors use OpenAI's shape: a budget or person limit is 402 (`insufficient_quota`, never retried), a rate limit 429 (600 calls a minute per token), a provider failure 502/503.
5. Usage is recorded once, by the gateway. The executor's plan-usage record is skipped for a proxied turn.

## Choosing the computer

The agent's own computer (or its code session's), else a workspace computer (`managed` or the server's `host`), never a person's: an agent with no computer of its own must not get a person's shell. It must be online, awake, with OpenCode on and installed, and on protocol 78 (`MODEL_PROXY_PROTOCOL`). Otherwise the agent falls back to the in-process model brain. Not proxied: missions, the right hand (its turn is locked down, ADR 0137), and a confidential thread (ADR 0190: its words never leave the server). A proxied run that finds its computer gone at turn time falls back to the model brain the same way (`brainUnavailable`).

## Consequences

- A proxied agent has the computer brain's tools (shell, files) under the agent's usual permission profile; this is the point, and the reason the computer choice above is strict.
- Pictures a person sends cannot be passed on (the gateway has no image block for a person's words); the proxy says a picture was left out.
- A proxied turn reuses the runner's pooled OpenCode process. Its provider points at a loopback relay in the runner (`apps/server/runner/model-proxy-relay.ts`, 127.0.0.1, a path only that process knows) which adds the bearer of the turn running now (the run tool token the pool already holds for its bridge), so the server still binds every call to the active run; with no turn running nothing is forwarded. The server keeps, per run and call id, the provider blocks the OpenAI format drops (Gemini's thought steps with their signatures) and puts them back when OpenCode sends the history again (in memory, lost on a restart). OpenCode's session-title agent is disabled in the config: it made a second paid call per new session. A provider's refusal is logged on the server with its status and words, never a key, and the OpenAI error body carries the provider's message.
- Plan usage meters do not count these turns; the Model Gateway does.

## Addendum of 2026-11-25: the web tools in a proxied turn are the server's

In a proxied turn the runner's OpenCode config denies OpenCode's own `webfetch` and `websearch` (`opencodeConfig` in `apps/server/runner/brain-opencode.ts`); OpenCode leaves a denied tool out of the model's request. The model then uses the bridge's `web_search` and `web_fetch`, which the server runs: outbound-guarded, recorded as `tool_call` steps, audited, and seen by the turn-end judge. With both sets offered, a model asked to use `web_search` fetched a search page with OpenCode's own tool; the judge saw no web call, judged the turn untried and a second, costly turn followed. Shell, files and edit are unchanged and follow the agent's permission profile. Non-proxied turns (plan accounts) are unchanged. The config is runner-local (no protocol change), and the pool signature already carries `proxy`, so a proxied process is never reused for a non-proxied turn.
