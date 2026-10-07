import type { ResolvedAgent } from './types.js';
export type CapabilitySupport = 'native' | 'emulated' | 'unsupported';
export interface AdapterCapabilities {
  instructions: CapabilitySupport;
  skills: CapabilitySupport;
  hooks: CapabilitySupport;
  mcp: CapabilitySupport;
}
export interface CompiledAgent<T = unknown> {
  adapterId: string;
  agentName: string;
  projectRoot: string;
  material: T;
}
export interface AlpRuntimeAdapter<T = unknown> {
  id: string;
  capabilities(): AdapterCapabilities;
  compile(agent: ResolvedAgent): Promise<CompiledAgent<T>>;
}
export function compileAgent<T>(adapter: AlpRuntimeAdapter<T>, agent: ResolvedAgent): Promise<CompiledAgent<T>>;
