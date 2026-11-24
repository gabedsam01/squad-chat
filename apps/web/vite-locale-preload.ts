import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { en } from "../../packages/i18n/src/en";
import { type AppLocale, isAppLocale, LOCALE_CODES } from "../../packages/i18n/src/locale";
import { fillPluralGaps, type LocaleStrings } from "../../packages/i18n/src/plurals";
import { ptBR } from "../../packages/i18n/src/pt-BR";

/** Where index.html's inline script takes each language's file: empty in development, where it preloads nothing. */
export const LOCALE_FILES = "/* LOCALE_FILES */ {}";

const VIRTUAL_CORE_PREFIX = "virtual:i18n-core/";
const VIRTUAL_REST_PREFIX = "virtual:i18n-rest/";

/**
 * Top-level i18n keys needed on cold boot (shell, auth, sidebar, channel, chat, composer, common, errors, and
 * inline chat cards). Route-heavy sections (`onboarding`, `settings`, `agentPage`, `live`, etc.) load in `rest`.
 */
export const CORE_I18N_KEYS = new Set<string>([
  "app",
  "common",
  "roles",
  "hosting",
  "auth",
  "desktopNotice",
  "island",
  "contextMenu",
  "install",
  "appIcon",
  "approvalCover",
  "rightHandApprovals",
  "noticePrefs",
  "webPushAsk",
  "shell",
  "agentGroups",
  "sidebarAgents",
  "sidebarPins",
  "appsDownload",
  "openOnPhone",
  "surface",
  "team",
  "sky",
  "channel",
  "receipts",
  "rightHand",
  "routing",
  "noAi",
  "keyGuard",
  "costlyCard",
  "brakes",
  "stretchCard",
  "usageCard",
  "usageQueue",
  "actionCard",
  "dm",
  "memoryCard",
  "reach",
  "teamChecks",
  "agentActions",
  "inlineProposal",
  "newChannel",
  "channelCategories",
  "channelMembers",
  "profile",
  "presence",
  "agentWork",
  "followUps",
  "mentions",
  "adminAsk",
  "accountRef",
  "accountSwitch",
  "channelRefs",
  "messageRefs",
  "linkPills",
  "folded",
  "secret",
  "question",
  "ask",
  "approval",
  "home",
  "notifications",
  "agent",
  "newAgentCard",
  "empty",
  "threads",
  "filters",
  "models",
  "timezone",
  "edit",
  "decision",
  "jev",
  "audience",
  "editors",
  "composer",
  "emoji",
  "voice",
  "media",
  "correctionAsk",
  "reactions",
  "palette",
  "code",
  "photo",
  "look",
  "run",
  "brain",
  "computer",
  "queue",
  "access",
  "artifacts",
  "blocks",
  "choices",
  "toolReview",
  "files",
  "errors",
  "outage",
  "gallery",
  "format",
  "work",
  "chat",
  "support",
  "limits",
  "desktop",
  "agentSide",
  "agentPicker",
  "whoSees",
  "share",
  "linkErrors",
]);

function loadRawLocale(code: AppLocale): LocaleStrings {
  if (code === "en") return en;
  if (code === "pt-BR") return fillPluralGaps("pt-BR", ptBR);
  const path = fileURLToPath(new URL(`../../packages/i18n/src/locales/${code}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as LocaleStrings;
  return fillPluralGaps(code, raw);
}

function splitLocaleSlice(code: AppLocale, kind: "core" | "rest"): LocaleStrings {
  const full = loadRawLocale(code);
  const slice: LocaleStrings = {};
  for (const [key, value] of Object.entries(full)) {
    const isCore = CORE_I18N_KEYS.has(key);
    if ((kind === "core" && isCore) || (kind === "rest" && !isCore)) slice[key] = value;
  }
  return slice;
}

function splitModuleCode(): string {
  const coreEntries = LOCALE_CODES.map(
    (code) => `  ${JSON.stringify(code)}: () => import("${VIRTUAL_CORE_PREFIX}${code}").then((m) => m.default),`,
  ).join("\n");
  const restEntries = LOCALE_CODES.map(
    (code) => `  ${JSON.stringify(code)}: () => import("${VIRTUAL_REST_PREFIX}${code}").then((m) => m.default),`,
  ).join("\n");
  return `export const loadCoreStrings = {\n${coreEntries}\n};\nexport const loadRestStrings = {\n${restEntries}\n};\n`;
}

/**
 * The language a bundled module is the file of: `packages/i18n/src/en.ts`, `pt-BR.ts`, `locales/<code>.json`, or a
 * built `virtual:i18n-core/<code>` chunk (never `rest`, which loads lazily after boot).
 */
export function localeOfModule(id: string): string | null {
  const normalized = id.replaceAll("\\", "/");
  const virtual = /^\0virtual:i18n-core\/([\w-]+)$/.exec(normalized);
  if (virtual) return virtual[1] ?? null;
  const m = /\/packages\/i18n\/src\/(?:locales\/([\w-]+)\.json|(en|pt-BR)\.ts)$/.exec(normalized);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * The person's language core file loads with the app instead of after it: the built index.html gets each language's
 * core chunk, and its inline script preloads the one it picks, as `savedLocale()` does (src/i18n/index.ts).
 */
export function preloadLocale(): Plugin {
  let base = "/";
  return {
    name: "agentes:preload-locale",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    resolveId(id) {
      if (id.startsWith(VIRTUAL_CORE_PREFIX) || id.startsWith(VIRTUAL_REST_PREFIX)) return `\0${id}`;
      return null;
    },
    load(id) {
      const normalized = id.replaceAll("\\", "/");
      const cleanId = normalized.split("?")[0] ?? "";
      if (cleanId.endsWith("/apps/web/src/i18n/split.ts")) return splitModuleCode();
      if (normalized.startsWith(`\0${VIRTUAL_CORE_PREFIX}`)) {
        const code = normalized.slice(`\0${VIRTUAL_CORE_PREFIX}`.length);
        if (!isAppLocale(code)) return null;
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(splitLocaleSlice(code, "core")))});`;
      }
      if (normalized.startsWith(`\0${VIRTUAL_REST_PREFIX}`)) {
        const code = normalized.slice(`\0${VIRTUAL_REST_PREFIX}`.length);
        if (!isAppLocale(code)) return null;
        return `export default JSON.parse(${JSON.stringify(JSON.stringify(splitLocaleSlice(code, "rest")))});`;
      }
      return null;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const files: Record<string, string> = {};
        for (const out of Object.values(ctx.bundle ?? {})) {
          const code = out.type === "chunk" && out.facadeModuleId ? localeOfModule(out.facadeModuleId) : null;
          if (code) files[code] = base + out.fileName;
        }
        return html.replace(LOCALE_FILES, JSON.stringify(files));
      },
    },
  };
}
