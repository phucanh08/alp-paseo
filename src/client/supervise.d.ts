export function holdDaemon(home: string, by?: string): Promise<void>;
export function releaseHold(home: string): Promise<void>;
export function daemonHeld(home: string): Promise<boolean>;
export function startDaemon(options: { home: string; entry?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string>;
export function superviseDaemon(options: {
  home: string;
  entry?: string | (() => string | undefined);
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  misses?: number;
  log?: (message: string) => void;
}): (() => Promise<void>) & { started: Promise<void> };
