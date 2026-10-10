export const DEFAULT_LANGUAGE: string;
export const LANGUAGE_CHARS: number;
export function userLanguage(home?: string): Promise<string>;
export function languageSetting(home: string): Promise<{ language: string | null; applies: string; default: string }>;
export function setLanguage(home: string | undefined, language: string | null): Promise<{ language: string | null; applies: string; default: string }>;
