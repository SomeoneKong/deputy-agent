// i18n engine: UI chrome is switchable between English and Chinese, single-language display, defaults to English.
// Task data (conversation / agent stream content / files / status.md body / task title) is not translated.
// The catalog is in messages.js; this module only handles language state / t() / static scanning / switch re-render.
import { MESSAGES } from "./messages.js";

const LS_KEY = "deputy.lang";
const SUPPORTED = ["en", "zh"];
const DEFAULT_LANG = "en";

function readLang() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v && SUPPORTED.includes(v)) return v;
  } catch {
    /* fall back to default when localStorage is unavailable */
  }
  return DEFAULT_LANG;
}

let currentLang = readLang();
const listeners = new Set();

export function getLang() {
  return currentLang;
}

/**
 * Get a chrome string. key looks like "nav.conversation".
 * params: `{name}` placeholder substitution. Missing key → fall back to en; still missing → return the key itself (to surface omissions).
 */
export function t(key, params) {
  const table = MESSAGES[currentLang] ?? MESSAGES[DEFAULT_LANG];
  let s = table[key];
  if (s === undefined) s = MESSAGES[DEFAULT_LANG][key];
  if (s === undefined) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Scan static DOM: [data-i18n] sets textContent; [data-i18n-attr="attr:key;attr2:key2"] sets attributes. */
export function applyStaticI18n(root = document) {
  for (const elm of root.querySelectorAll("[data-i18n]")) {
    elm.textContent = t(elm.getAttribute("data-i18n"));
  }
  for (const elm of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of elm.getAttribute("data-i18n-attr").split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (attr && key) elm.setAttribute(attr, t(key));
    }
  }
}

/** Register a language-change callback (e.g. re-render the current view). Returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Switch language: persist + update <html lang> + re-scan static + notify subscribers to re-render. */
export function setLang(lang) {
  if (!SUPPORTED.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(LS_KEY, lang);
  } catch {
    /* persistence failure does not block the switch */
  }
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  applyStaticI18n();
  for (const fn of listeners) fn(lang);
}

/** Startup initialization: apply the persisted language to <html lang> + static scan. */
export function initI18n() {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
  applyStaticI18n();
}
