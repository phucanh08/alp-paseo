import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AlpError } from './errors.js';
import { validateUserSettings } from './validation.js';

/**
 * The user's own settings in $ALP_HOME/settings.json that ALP and its screens edit
 * (ALPD §54). The language is the one everything the user reads is written in:
 * agents' messages and questions, approvals, and ALP's own notices.
 */

/** The language ALP and its agents write in for the user when none is set. */
export const DEFAULT_LANGUAGE = 'Vietnamese';
export const LANGUAGE_CHARS = 40;

async function readSettings(home) {
  const file = path.join(home, 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { file, settings: {} }; throw error; }
  let settings;
  try { settings = JSON.parse(text); }
  catch (cause) { throw new AlpError('INVALID_SETTINGS', `${file}: ${cause.message}`, { cause }); }
  return { file, settings: validateUserSettings(settings, file) };
}

/** The user's language: their setting, else Vietnamese. A broken settings file falls back too. */
export async function userLanguage(home) {
  if (!home) return DEFAULT_LANGUAGE;
  try { return (await readSettings(home)).settings.language ?? DEFAULT_LANGUAGE; }
  catch { return DEFAULT_LANGUAGE; }
}

/** What the settings screen shows: the language set, if any, and the one that applies. */
export async function languageSetting(home) {
  const { settings } = await readSettings(home);
  return { language: settings.language ?? null, applies: settings.language ?? DEFAULT_LANGUAGE, default: DEFAULT_LANGUAGE };
}

/**
 * Sets the user's language, or clears it with null so the default applies. Other keys
 * of settings.json are kept as they are.
 */
export async function setLanguage(home, language) {
  if (!home) throw new AlpError('INVALID_SCOPE', 'No library: ALP_HOME is not set');
  if (language !== null && (typeof language !== 'string' || !language.trim() || language.trim().length > LANGUAGE_CHARS)) {
    throw new AlpError('INVALID_SETTINGS', `A language is a name of at most ${LANGUAGE_CHARS} characters, such as Vietnamese or English`);
  }
  const { file, settings } = await readSettings(home);
  const next = { ...settings };
  if (language === null) delete next.language; else next.language = language.trim();
  validateUserSettings(next, file);
  await mkdir(home, { recursive: true });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
  await rename(temporary, file);
  return languageSetting(home);
}
