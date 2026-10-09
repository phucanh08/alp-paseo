export const VERIFY_STEPS: readonly ['setup', 'typecheck', 'test'];
export const VERIFY_TIMEOUT_SEC: number;

export type VerifyConfig = { setup?: string; typecheck?: string; test?: string; timeoutSec: number };

export type VerifyCommand = { step: 'setup' | 'typecheck' | 'test'; command: string; exitCode: number; ms: number; output: string; timedOut?: boolean };

export type Verification = { passed: boolean; cwd: string; commands: VerifyCommand[] };

export function validateVerify(verify: unknown, source: string): VerifyConfig | undefined;
export function verifyConfig(projectRoot: string): Promise<VerifyConfig | undefined>;
export function runVerify(cwd: string, config: VerifyConfig, options?: { env?: NodeJS.ProcessEnv }): Promise<Verification>;
export function describeVerification(verified: { passed: boolean; commands: Array<{ step: string; exitCode: number; timedOut?: boolean }>; skipped?: string }): string;
