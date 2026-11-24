import { loadStrings } from "@agenteschat/i18n/load";
import type { AppLocale } from "@agenteschat/i18n/locale";
import type { LocaleStrings } from "@agenteschat/i18n/plurals";

export const loadCoreStrings: Record<AppLocale, () => Promise<LocaleStrings>> = loadStrings;
export const loadRestStrings: Record<AppLocale, () => Promise<LocaleStrings>> | null = null;
