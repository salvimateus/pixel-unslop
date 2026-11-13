import { readStored, writeStored } from './storage.ts';

const STORE_KEY = 'locale';

/** The interface languages, in the order of the selector. Each value is a BCP 47 tag. */
export const LOCALES = ['pt-BR', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** The name of each language in that language. */
export const LOCALE_NAMES: Record<Locale, string> = { 'pt-BR': 'Português', en: 'English' };

/** The language of the first start: a system language that starts with "pt" gives pt-BR, every other one gives English. */
function systemLocale(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

/** A stored value as a locale, or `fallback` when the value is missing or not a known locale. */
export function parseLocale(raw: string | null, fallback: Locale): Locale {
  return raw !== null && (LOCALES as readonly string[]).includes(raw) ? (raw as Locale) : fallback;
}

let active = $state<Locale>(parseLocale(readStored(STORE_KEY), systemLocale()));

/** The language in use. A read in a template, a `$derived` or an `$effect` runs again when the language changes. */
export function activeLocale(): Locale {
  return active;
}

/** Changes the interface language at once, sets the language of the document and keeps the choice for the next start. */
export function setLocale(next: Locale): void {
  if (next === active) return;
  active = next;
  document.documentElement.lang = next;
  writeStored(STORE_KEY, next);
}
