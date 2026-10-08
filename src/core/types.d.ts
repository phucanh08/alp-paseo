/** Disk configuration; no provider SDK types. */
export interface RawSettings {
  defaultAgent?: string;
  workflow?: { mode?: 'smart' | 'supervised'; maxPeers?: number };
  delegation?: Record<string, string[]>;
  runtime?: { provider?: string; model?: string; reasoning?: string };
}
export interface RawMcpServer {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export interface RawMcpConfig { mcpServers?: Record<string, RawMcpServer> }
export interface ResolvedResource { name: string; path: string }
export interface ResolvedMcpConfig { mcpServers: Record<string, RawMcpServer> }
/** JSON-serializable adapter input. All filesystem resource paths/cwd are absolute. */
export interface ResolvedAgent {
  name: string;
  projectRoot: string;
  instructions: { project: string; agent: string };
  skills: ResolvedResource[];
  hooks: ResolvedResource[];
  mcp: ResolvedMcpConfig;
  runtime: { provider?: string; model?: string; reasoning?: string };
}
