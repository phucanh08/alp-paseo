import type { Task } from './tasks.js';

export type FormulaStep = { id: string; title: string; description?: string; type: string; needs: string[]; priority?: number; labels?: string[]; paths?: string[] };
export type Formula = {
  formula: string;
  title?: string;
  description?: string;
  version?: number;
  priority?: number;
  vars: Record<string, { description?: string; required: boolean; default?: string }>;
  steps: FormulaStep[];
};
/** Parses TOML text; the core has none of its own (e.g. smol-toml's parse). */
export type TomlParser = (text: string) => unknown;
type Parsers = { toml?: TomlParser };
export type FormulaEntry = { name: string; file: string; formula?: Formula; error?: string };

export const MAX_STEPS: number;
export function formulaDirs(projectRoot: string, home?: string): string[];
export function listFormulas(projectRoot: string, home?: string, parsers?: Parsers): Promise<FormulaEntry[]>;
export function findFormula(projectRoot: string, home: string | undefined, name: string, parsers?: Parsers): Promise<FormulaEntry & { formula: Formula }>;
export function loadFormula(file: string, parsers?: Parsers): Promise<Formula>;
export function validateFormula(data: unknown): Formula;
export function resolveVars(formula: Formula, given?: Record<string, string>): Record<string, string>;
export function pourFormula(projectRoot: string, formula: Formula, given: Record<string, string> | undefined, by: string, options?: { dryRun?: boolean; parent?: string }): Promise<{ epic: Task; tasks: Task[] }>;
