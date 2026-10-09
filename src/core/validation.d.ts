export const PROJECT_SETTINGS: string[];
export const USER_SETTINGS: string[];
export const RETIRED_SETTINGS: { project: Record<string, string>; user: Record<string, string> };
export function settingsKeys(settings: unknown, known: string[], retired?: Record<string, string>): { unknown: Array<{ key: string; suggestion?: string }>; retired: Array<{ key: string; instead: string }> };
export function settingsWarnings(settings: unknown, scope: 'project' | 'user'): string[];
export function validateSettings(settings: unknown, source: string): { provider?: string; model?: string; reasoning?: string };
export function validateUserSettings(settings: unknown, source: string): { permissions?: unknown; limits?: { autoResume?: boolean }; recovery?: { autoResume?: boolean } };
export function normalizeMcp(raw: unknown, directory: string, source: string): { mcpServers: Record<string, Record<string, unknown>> };
export function validateResolvedAgent(agent: unknown): unknown;
