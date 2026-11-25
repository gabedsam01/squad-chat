import { type LocaleState, useLocaleSync } from "@agenteschat/client/lib/locale-sync";
import { resources } from "@agenteschat/i18n";
import {
  type AppLocale,
  appLocale,
  DEFAULT_LOCALE,
  isAppLocale,
  LOCALE_CODES,
  localeInfo,
  readyLocales,
} from "@agenteschat/i18n/locale";
import i18n, { type i18n as I18n, type InitOptions } from "i18next";
import { useEffect, useState } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { reloadForNewVersion } from "@/lib/app-version";
import { loadCoreStrings, loadRestStrings } from "./split";

export type LocaleCode = AppLocale;
export { DEFAULT_LOCALE };

/** The languages people can pick, each by its own name (never translated). */
export const locales = readyLocales().map((l) => ({ code: l.code, label: l.native }));

/**
 * `<Trans>` props for values people typed (a name): interpolated escaped, then shown as the same text. The app's
 * `escapeValue: false` leaves escaping to React, but `<Trans>` parses the interpolated string first, so a typed
 * `<strong>` would become an element.
 */
export const TYPED_VALUES = { tOptions: { interpolation: { escapeValue: true } }, shouldUnescape: true };

/** This browser's language choice: a code, or "auto" (the browser's own). */
const STORAGE_KEY = "agentes.locale";
/** "1" while a choice made signed out waits for the next sign-in to reach the server. */
const PENDING_KEY = "agentes.locale.pending";
/** The landing's language switch (squadchat), shared with the app's host. */
const LANDING_COOKIE = "agentes_locale";

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function readLocaleState(): LocaleState {
  const v = read(STORAGE_KEY);
  return { stored: v === "auto" || isAppLocale(v) ? v : null, pending: read(PENDING_KEY) === "1" };
}

export function rememberLocale(store: AppLocale | "auto", pending: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, store);
    if (pending) localStorage.setItem(PENDING_KEY, "1");
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Not persisted; still applies to this tab.
  }
}

/** The browser's own language among those people can pick ("pt-PT" → pt-BR, "en-GB" → en), else English. */
export const detectedLocale = (languages: readonly string[] = browserLanguages()): AppLocale =>
  appLocale(languages) ?? DEFAULT_LOCALE;

const cookieValue = (cookie: string, name: string) =>
  cookie
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

/**
 * The language to start in: this browser's choice, else the one picked on the landing (its cookie), else the
 * browser's own, else English.
 */
export function savedLocale(
  languages: readonly string[] = browserLanguages(),
  cookie: string = typeof document === "undefined" ? "" : document.cookie,
): LocaleCode {
  const { stored } = readLocaleState();
  if (stored && stored !== "auto") return stored;
  if (stored === "auto") return detectedLocale(languages);
  return appLocale([cookieValue(cookie, LANDING_COOKIE)]) ?? detectedLocale(languages);
}

const retryOnce = <T>(load: () => Promise<T>) => load().catch(() => load());

/** The rest part is loaded after first paint, so a flaky network right after a deploy must not leave its keys raw for good. */
export async function retryWithBackoff<T>(load: () => Promise<T>, tries = 4, delayMs = 500): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
}

const restLoaded = new WeakMap<I18n, Set<LocaleCode>>();
const restSetFor = (instance: I18n) => {
  let set = restLoaded.get(instance);
  if (!set) {
    set = new Set();
    restLoaded.set(instance, set);
  }
  return set;
};

/** Downloads `code` into the instance without switching to it (a page shown in another language). */
export async function loadLocale(code: LocaleCode, instance: I18n = i18n): Promise<void> {
  const restLoader = loadRestStrings?.[code];
  if (instance.hasResourceBundle(code, "translation")) {
    if (!restLoader || restSetFor(instance).has(code)) return;
    const rest = await retryWithBackoff(restLoader);
    instance.addResourceBundle(code, "translation", rest, true, true);
    restSetFor(instance).add(code);
    return;
  }
  const [core, rest] = await Promise.all([
    retryOnce(loadCoreStrings[code]),
    restLoader ? retryWithBackoff(restLoader) : Promise.resolve(null),
  ]);
  instance.addResourceBundle(code, "translation", core, true, true);
  if (rest) {
    instance.addResourceBundle(code, "translation", rest, true, true);
    restSetFor(instance).add(code);
  }
}

/** `t` in `lang` for a page shown in another language than the app's: the app's until `lang` has downloaded. */
export function usePageT(lang: LocaleCode) {
  const { i18n: instance } = useTranslation();
  const [loaded, setLoaded] = useState<LocaleCode | null>(null);
  useEffect(() => {
    loadLocale(lang, instance)
      .then(() => setLoaded(lang))
      .catch(() => {});
  }, [lang, instance]);
  return instance.getFixedT(loaded === lang ? lang : instance.language);
}

/** The language picked last (a slower download of an earlier pick must not win). */
let wanted: LocaleCode | null = null;

/** Shows the app in `code` once it has downloaded (if it can't, the language stays as it was). */
export function setLocale(code: LocaleCode, instance: I18n = i18n) {
  wanted = code;
  const apply = () => {
    if (wanted !== code) return;
    void instance.changeLanguage(code);
    if (typeof document !== "undefined") document.documentElement.lang = code;
  };
  if (instance.hasResourceBundle(code, "translation")) apply();
  else
    loadLocale(code, instance)
      .then(apply)
      .catch(() => {});
}

/** The person's pick in a language picker, kept on this browser (to send at the next sign-in when signed out). */
export function chooseLocale(choice: AppLocale | "auto", instance: I18n, signedIn: boolean): AppLocale {
  const code = choice === "auto" ? detectedLocale() : choice;
  rememberLocale(choice, !signedIn);
  setLocale(code, instance);
  return code;
}

/** What the server should keep for a pick in Settings: the language, or the browser's own and "auto". */
export const localePatch = (choice: AppLocale | "auto") =>
  choice === "auto" ? { locale: detectedLocale(), auto: true } : { locale: choice, auto: false };

/** The signed-in person's language on this browser and on the server, matched once their `/me` arrives (ADR 0122). */
export function useServerLocale(user: { id: string; locale?: string | null; localeAuto?: boolean } | undefined) {
  const { i18n: instance } = useTranslation();
  const api = useApi();
  useLocaleSync({
    user,
    read: readLocaleState,
    detected: () => detectedLocale(),
    apply: (code, store) => {
      rememberLocale(store, false);
      if (code !== instance.language) setLocale(code, instance);
    },
    send: (patch) => api.account.updateMe(patch),
  });
}

const options = (lng: LocaleCode): InitOptions => ({
  lng,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALE_CODES,
  load: "currentOnly",
  // `device`: this computer's name in the desktop app's words ("Use this Mac"; lib/desktop.ts sets it there).
  interpolation: { escapeValue: false, defaultVariables: { device: "Mac" } },
  initAsync: false,
  returnNull: false,
  react: { bindI18nStore: "added" },
});

/**
 * The app's instance with only `lng` downloaded (index.html preloads it): a ready language holds every key (ADR 0122),
 * so English, every key's fallback, comes only with one that isn't ready.
 */
export async function loadI18n(lng: LocaleCode): Promise<I18n> {
  const codes = [...new Set<LocaleCode>(localeInfo(lng).ready ? [lng] : [lng, DEFAULT_LOCALE])];
  const strings = await Promise.all(codes.map((code) => retryOnce(loadCoreStrings[code])));
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({
    ...options(lng),
    resources: Object.fromEntries(codes.map((code, i) => [code, { translation: strings[i] ?? {} }])),
  });
  if (loadRestStrings) {
    const restLoaders = loadRestStrings;
    // A timeout: a busy main thread right after boot must not hold the rest part back indefinitely.
    const idle = (fn: () => void) =>
      typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 1);
    idle(() => {
      for (const code of codes) {
        void retryWithBackoff(restLoaders[code])
          .then((rest) => {
            instance.addResourceBundle(code, "translation", rest, true, true);
            restSetFor(instance).add(code);
          })
          .catch((error) => {
            // Its keys stay raw until a reload: a stale page's chunk is gone, so this takes the new version in once.
            console.error(`i18n: the ${code} rest strings did not load`, error);
            void reloadForNewVersion();
          });
      }
    });
  }
  return instance;
}

/** The product's name in the tabs' titles, where a registered host shows its own (ADR 0194). */
const PRODUCT_NAME = "squadchat";
let tabBrand: string | null = null;
let retitle = () => {};
const branded = (title: string) => {
  const brand = tabBrand;
  return brand ? title.replaceAll(PRODUCT_NAME, () => brand) : title;
};

/** Every tab title from now on names `name` where it names the product (a registered host's pages, ADR 0194). */
export function brandTabTitle(name: string) {
  // A name holding the product's own would be replaced again on every change.
  tabBrand = name.includes(PRODUCT_NAME) ? null : name;
  retitle();
}

/**
 * The tab's default title in the app's language (index.html's is English). A page with its own title puts back the
 * one it found when it goes, which may be an earlier language's default: that one is swapped for today's wherever it
 * shows, so a page's own title stays, and so does the unread count in front of the default.
 */
export function translateTabTitle(instance: I18n) {
  const earlier = new Set<string>();
  let shown = instance.t("app.tabTitle");
  const swap = () => {
    let title = document.title;
    for (const was of earlier) title = title.replace(branded(was), shown).replace(was, shown);
    title = branded(title);
    if (title !== document.title) document.title = title;
  };
  retitle = swap;
  document.title = branded(shown);
  instance.on("languageChanged", () => {
    earlier.add(shown);
    shown = instance.t("app.tabTitle");
    earlier.delete(shown);
    swap();
  });
  new MutationObserver(swap).observe(document.head, { subtree: true, childList: true, characterData: true });
}

/** An instance with every language loaded at once (tests). */
export function createI18n(lng: LocaleCode = DEFAULT_LOCALE): I18n {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({ ...options(lng), resources });
  return instance;
}
