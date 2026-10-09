import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * The ALP settings screen's contract with the plugin server (plans/reference/ALPD.md §43).
 * Shared by the client bundle and the server bundle, so it imports only the SDK and zod.
 * `directory` is the workspace the screen was opened from; without one, or outside an
 * ALP project, only the built-ins and the library apply and the project scope is refused.
 */

const Directory = z.string().min(1).optional();
export const KindSchema = z.enum(['agents', 'skills', 'mcp', 'hooks', 'teams']);
export const ScopeSchema = z.enum(['library', 'project']);
const Name = z.string().regex(/^[\w.-]+$/).refine(name => name !== '.' && name !== '..');
const Source = z.enum(['builtin', 'library', 'project']);

export const EntryRowSchema = z.object({
  name: z.string(),
  source: Source,
  overrides: Source.optional(),
  path: z.string().optional(),
  description: z.string().optional(),
  usedBy: z.array(z.string()).optional(),
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

export const libraryList = defineRpc({
  name: 'alp.library.list',
  input: z.object({ directory: Directory, kind: KindSchema }),
  output: z.object({ projectRoot: z.string().nullable(), library: z.string(), entries: z.array(EntryRowSchema) }),
});

export const libraryGet = defineRpc({
  name: 'alp.library.get',
  input: z.object({ directory: Directory, kind: KindSchema, name: Name, scope: ScopeSchema.optional() }),
  output: z.object({
    kind: KindSchema, name: z.string(), source: Source, overrides: Source.optional(),
    content: z.record(z.string(), z.unknown()),
    /** Pass back with a save or delete; a different current revision refuses it. */
    revision: z.string().nullable(),
    usedBy: z.array(z.string()),
  }),
});

export const librarySave = defineRpc({
  name: 'alp.library.save',
  input: z.object({
    directory: Directory, kind: KindSchema, name: Name, scope: ScopeSchema,
    content: z.record(z.string(), z.unknown()),
    /** null creates; a string replaces that revision; omitted overwrites. */
    revision: z.string().nullable().optional(),
  }),
  output: z.object({ revision: z.string().nullable() }),
});

export const libraryDelete = defineRpc({
  name: 'alp.library.delete',
  input: z.object({ directory: Directory, kind: KindSchema, name: Name, scope: ScopeSchema, revision: z.string().optional() }),
  /** now: the layer that applies again after removing an override. */
  output: z.object({ removed: z.boolean(), now: Source.optional() }),
});

export const libraryDuplicate = defineRpc({
  name: 'alp.library.duplicate',
  input: z.object({ directory: Directory, kind: KindSchema, from: Name, to: Name, scope: ScopeSchema }),
  output: z.object({ revision: z.string().nullable() }),
});

export const libraryRename = defineRpc({
  name: 'alp.library.rename',
  input: z.object({ directory: Directory, kind: KindSchema, from: Name, to: Name, scope: ScopeSchema }),
  output: z.object({ revision: z.string().nullable() }),
});

export const libraryTest = defineRpc({
  name: 'alp.library.test',
  input: z.object({ directory: Directory, kind: z.enum(['mcp', 'hooks']), name: Name, scope: ScopeSchema.optional() }),
  output: z.object({
    ok: z.boolean(),
    /** MCP: the server and its tools. */
    server: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
    /** Hooks: how the sample run went. */
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    timedOut: z.boolean().optional(),
    wouldBlock: z.boolean().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    durationMs: z.number().optional(),
  }),
});
