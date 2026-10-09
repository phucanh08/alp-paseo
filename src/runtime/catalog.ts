/** Models, modes and thinking options the runtime accepts; viewers render them as-is. */
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CLAUDE_MODEL = 'sonnet';
// Main's and the supervisor's models and effort come from the session's team: templates/teams/<id>/team.json (ALPD §42).
/** Oracle runs on one of these; main may consult both for two opinions. */
export const ORACLE_MODELS = ['claude:claude-fable-5-1', 'codex:gpt-6-astra'];
export const ORACLE_THINKING = 'high';
export const modes = [{ id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace write' }, { id: 'full-access', label: 'Full access' }];
const modeRank: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
/** Whether a session in `mode` may run with `requested`; a child never exceeds its requester. */
export const withinMode = (requested: string, mode: string) => (modeRank[requested] ?? 3) <= (modeRank[mode] ?? -1);
export const writes = (mode: string) => mode !== 'read-only';
const option = (id: string) => ({ id, label: id });
const options = (ids: string[]) => ids.map(option);
const codexFull = options(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const codexStandard = options(['low', 'medium', 'high', 'xhigh', 'max']);
const claudeFull = options(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const claudeLegacy = options(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const claude46 = options(['off', 'low', 'medium', 'high', 'max']);
export const thinkingOptions = options(['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']);

const model = (runtime: 'codex' | 'claude', id: string, label: string, description: string, modelThinkingOptions: Array<{ id: string; label: string }>, defaultThinkingOptionId?: string) => ({
  id: `${runtime}:${id}`,
  label: `${runtime === 'codex' ? 'Codex' : 'Claude Code'} · ${label}`,
  description,
  thinkingOptions: modelThinkingOptions,
  ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
});

export const models = [
  model('codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', codexFull, 'low'),
  model('codex', 'gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', codexFull, 'low'),
  model('codex', 'gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', codexFull, 'low'),
  model('codex', 'gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', codexStandard, 'low'),
  model('codex', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.', codexFull, 'low'),
  model('codex', 'gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', codexFull, 'low'),
  model('codex', 'gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.', codexStandard, 'low'),
  model('claude', 'claude-opus-5-5', 'Opus 5.5', 'Latest release.', claudeFull, 'medium'),
  model('claude', 'claude-opus-5', 'Opus 5', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-fable-5-1', 'Fable 5.1', 'Most powerful model.', claudeFull, 'high'),
  model('claude', 'claude-fable-5', 'Fable 5', 'Previous release.', claudeFull, 'high'),
  model('claude', 'claude-opus-4-8[1m]', 'Opus 4.8 1M', 'Opus 4.8 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-8', 'Opus 4.8', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Best for everyday tasks.', claudeFull, 'medium'),
  model('claude', 'claude-sonnet-5', 'Sonnet 5', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-sonnet-5[1m]', 'Sonnet 5 1M', 'Sonnet 5 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-7[1m]', 'Opus 4.7 1M', 'Opus 4.7 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-7', 'Opus 4.7', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-6[1m]', 'Opus 4.6 1M', 'Opus 4.6 with 1M context window.', claude46, 'high'),
  model('claude', 'claude-opus-4-6', 'Opus 4.6', 'Most capable for complex work.', claude46, 'high'),
  model('claude', 'claude-sonnet-4-6[1m]', 'Sonnet 4.6 1M', 'Sonnet 4.6 with 1M context window.', claude46, 'high'),
  model('claude', 'claude-sonnet-4-6', 'Sonnet 4.6', 'Best for everyday tasks.', claude46, 'high'),
  model('claude', 'claude-haiku-4-5', 'Haiku 4.5', 'Fastest for quick answers.', [], undefined),
  model('claude', 'sonnet', 'sonnet', 'From Claude settings.json model.', [], undefined),
];

export function thinkingOptionsFor(runtime: 'codex' | 'claude', nativeModel: string) {
  return models.find(candidate => candidate.id === `${runtime}:${nativeModel}`)?.thinkingOptions ?? thinkingOptions;
}
