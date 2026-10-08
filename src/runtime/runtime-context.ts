/** Bounded optional reads. Never expose account identifiers or credentials. */
export async function optionalRead<T>(read: () => Promise<T>, timeout = 1500): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read).catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout); })]);
  } finally { clearTimeout(timer); }
}

export function codexUsage(result: any) {
  if (!result?.rateLimits) return { available: false };
  const clean = (limit: any) => ({
    name: limit?.limitName ?? null, model: limit?.normalModelSlug ?? null,
    plan: limit?.planType ?? null,
    windows: [limit?.primary, limit?.secondary].filter(Boolean).map(window => ({
      usedPercent: window.usedPercent,
      remainingPercent: typeof window.usedPercent === 'number' ? Math.max(0, 100 - window.usedPercent) : null,
      windowMinutes: window.windowDurationMins, resetsAt: window.resetsAt,
    })),
    spendControlReached: limit?.spendControlReached ?? null,
  });
  return { available: true, ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    limits: Object.values(result.rateLimitsByLimitId ?? { default: result.rateLimits }).map(clean) };
}

export function claudeUsage(result: any) {
  if (!result) return { available: false };
  return { available: result.rate_limits_available === true, plan: result.subscription_type ?? null,
    windows: Object.entries(result.rate_limits ?? {}).flatMap(([name, window]: [string, any]) =>
      window && ('utilization' in window) ? [{ name, usedPercent: window.utilization,
        remainingPercent: typeof window.utilization === 'number' ? Math.max(0, 100 - window.utilization) : null,
        resetsAt: window.resets_at }] : []) };
}
