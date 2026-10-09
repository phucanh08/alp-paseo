import { DESCRIPTION_CHARS, MAX_LABELS, TASK_TYPES, batch, isTaskId } from './tasks.js';

/**
 * Interchange with beads (github.com/gastownhall/beads) through its JSONL issue
 * format: `bd export` writes one issue per line and `bd import` upserts them.
 * Relations become beads dependencies stored on the dependent issue
 * ({ issue_id, depends_on_id, type }); what beads has no field for (review,
 * gates, paths, handoffs) rides in metadata.alp, so ALP → beads → ALP keeps it.
 */

const DEPENDENCY = { blockedBy: 'blocks', parent: 'parent-child', discoveredFrom: 'discovered-from', related: 'related' };
const RELATION = Object.fromEntries(Object.entries(DEPENDENCY).map(([relation, type]) => [type, relation]));
const LABEL = /^[\w.:/-]{1,50}$/;

/** Tasks as beads issues, sorted by id like bd export. */
export function exportBeads(tasks) {
  return [...tasks].sort((a, b) => a.id.localeCompare(b.id)).map(task => {
    const dependencies = [
      ...task.blockedBy.map(id => [id, 'blocks']),
      ...(task.parent ? [[task.parent, 'parent-child']] : []),
      ...(task.discoveredFrom ? [[task.discoveredFrom, 'discovered-from']] : []),
      ...task.related.map(id => [id, 'related']),
    ].map(([dependsOn, type]) => ({ issue_id: task.id, depends_on_id: dependsOn, type }));
    const timers = task.gates.filter(gate => gate.kind === 'timer' && !gate.resolved).map(gate => gate.until).sort();
    const alp = {
      ...(task.status === 'review' ? { status: 'review' } : {}),
      ...(task.paths.length ? { paths: task.paths } : {}),
      ...(task.gates.length ? { gates: task.gates } : {}),
      ...(task.handoff ? { handoff: task.handoff } : {}),
      ...(task.closed ? { closed: task.closed } : {}),
      ...(task.compacted ? { compacted: task.compacted } : {}),
      ...(task.step ? { step: task.step } : {}),
      ...(task.formula ? { formula: task.formula } : {}),
    };
    return {
      id: task.id,
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      status: task.status === 'review' ? 'in_progress' : task.status,
      priority: task.priority,
      issue_type: task.type,
      ...(task.assignee ? { assignee: task.assignee.agent } : {}),
      ...(task.labels.length ? { labels: task.labels } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      created_at: task.createdAt,
      created_by: task.createdBy,
      updated_at: task.updatedAt,
      ...(task.closed ? { closed_at: task.closed.at, close_reason: task.closed.summary ?? task.closed.reason } : {}),
      ...(timers.length ? { defer_until: timers.at(-1) } : {}),
      ...(task.external ? { external_ref: task.external.id, source_system: task.external.system } : {}),
      ...(Object.keys(alp).length ? { metadata: { alp } } : {}),
    };
  });
}

/** Parses JSONL, keeping the line number of every record or error. */
export function parseJsonl(text) {
  const records = [];
  const errors = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not a JSON object');
      records.push({ line: index + 1, record });
    } catch (error) {
      errors.push({ line: index + 1, reason: error.message });
    }
  });
  return { records, errors };
}

const sections = record => [
  typeof record.description === 'string' ? record.description : '',
  ...[['design', 'Design'], ['acceptance_criteria', 'Acceptance criteria'], ['notes', 'Notes']]
    .filter(([key]) => typeof record[key] === 'string' && record[key].trim())
    .map(([key, title]) => `## ${title}\n\n${record[key].trim()}`),
].filter(Boolean).join('\n\n');

/** metadata.alp, whether beads wrote metadata as an object or as JSON text. */
function alpOf(record) {
  let metadata = record.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { return {}; } }
  return metadata?.alp && typeof metadata.alp === 'object' && !Array.isArray(metadata.alp) ? metadata.alp : {};
}

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** What an issue becomes in ALP, apart from its relations and status. */
function taskFields(record) {
  const type = TASK_TYPES.includes(record.issue_type) ? record.issue_type : 'task';
  const labels = [
    ...(Array.isArray(record.labels) ? record.labels.filter(label => typeof label === 'string' && LABEL.test(label)) : []),
    ...(record.issue_type && type !== record.issue_type && LABEL.test(`beads:${record.issue_type}`) ? [`beads:${record.issue_type}`] : []),
  ];
  const priority = Number.isInteger(record.priority) ? Math.min(4, Math.max(0, record.priority)) : 2;
  const alp = alpOf(record);
  return {
    title: clip(String(record.title).trim(), 200),
    description: clip(sections(record), DESCRIPTION_CHARS),
    type,
    priority,
    labels: [...new Set(labels)].slice(0, MAX_LABELS),
    ...(Array.isArray(alp.paths) ? { paths: alp.paths.filter(entry => typeof entry === 'string') } : {}),
  };
}

/** Parents before children, so a child's numbered id can follow its parent's. */
function byParent(entries, parentOf) {
  const ordered = [];
  const placed = new Set();
  const visit = (entry, trail = new Set()) => {
    if (placed.has(entry.record.id) || trail.has(entry.record.id)) return;
    trail.add(entry.record.id);
    const parent = entries.find(candidate => candidate.record.id === parentOf(entry.record));
    if (parent) visit(parent, trail);
    placed.add(entry.record.id);
    ordered.push(entry);
  };
  for (const entry of entries) visit(entry);
  return ordered;
}

/**
 * Upserts beads issues into the project's tasks, as bd import does: an issue
 * whose id is an ALP task id, or that ALP imported before (external beads id),
 * updates that task; any other becomes a new task. Missing records are never deleted.
 * @returns {Promise<{ created: Array<{ id: string, from: string }>, updated: Array<{ id: string, from: string }>, skipped: Array<{ line: number, reason: string }>, warnings: string[] }>}
 */
export async function importBeads(projectRoot, records, { dryRun = false, by = 'user' } = {}) {
  const report = { created: [], updated: [], skipped: [], warnings: [] };
  const usable = [];
  for (const { line, record } of records) {
    // bd export marks issues with _type; other record types are not tasks.
    if (record._type !== undefined && record._type !== 'issue') report.skipped.push({ line, reason: `${record._type} record, not an issue` });
    else if (typeof record.title !== 'string' || !record.title.trim()) report.skipped.push({ line, reason: 'no title' });
    else if (typeof record.id !== 'string' || !record.id.trim()) report.skipped.push({ line, reason: 'no id' });
    else if (record.status === 'tombstone') report.skipped.push({ line, reason: `${record.id} is deleted (tombstone)` });
    else if (record.ephemeral === true || record.wisp === true) report.skipped.push({ line, reason: `${record.id} is ephemeral` });
    else usable.push({ line, record });
  }
  const dependencies = record => (Array.isArray(record.dependencies) ? record.dependencies : [])
    .filter(dep => dep && typeof dep.depends_on_id === 'string' && (dep.issue_id === undefined || dep.issue_id === record.id));
  const parentOf = record => dependencies(record).find(dep => dep.type === 'parent-child')?.depends_on_id ?? (typeof record.parent === 'string' ? record.parent : undefined);

  return batch(projectRoot, ({ tasks, add, touch, link }) => {
    const ids = new Map();
    const find = foreign => ids.get(foreign)
      ?? tasks.find(task => task.id === foreign && isTaskId(foreign))?.id
      ?? tasks.find(task => task.external?.system === 'beads' && task.external.id === foreign)?.id;

    for (const { line, record } of byParent(usable, parentOf)) {
      try {
        const values = taskFields(record);
        const alp = alpOf(record);
        const existing = find(record.id);
        let task;
        let before;
        if (existing) {
          task = tasks.find(entry => entry.id === existing);
          before = JSON.stringify(task);
          Object.assign(task, values);
        } else {
          const parent = parentOf(record) ? find(parentOf(record)) : undefined;
          if (parentOf(record) && !parent) report.warnings.push(`${record.id}: parent ${parentOf(record)} is not in the file or the project`);
          task = add({ ...values, ...(parent ? { parent } : {}) }, by, {
            id: record.id,
            createdAt: typeof record.created_at === 'string' ? record.created_at : undefined,
            event: 'imported', details: { from: record.id },
            extra: {
              ...(typeof record.created_by === 'string' && record.created_by ? { createdBy: record.created_by } : {}),
              ...(Array.isArray(alp.gates) ? { gates: alp.gates } : {}),
              ...(alp.step ? { step: alp.step } : {}),
              ...(alp.formula ? { formula: alp.formula } : {}),
            },
          });
          if (task.id !== record.id) task.external = { system: 'beads', id: record.id };
          report.created.push({ id: task.id, from: record.id });
        }
        ids.set(record.id, task.id);
        applyStatus(task, record, alp, by, report);
        const deferred = typeof record.defer_until === 'string' && Date.parse(record.defer_until) > Date.now() ? new Date(record.defer_until).toISOString() : undefined;
        // bd keeps whole seconds, so a timer within a second of defer_until is the same one.
        if (deferred && !task.gates.some(gate => gate.kind === 'timer' && Math.abs(Date.parse(gate.until) - Date.parse(deferred)) < 1000)) {
          const next = Math.max(0, ...task.gates.map(gate => Number(gate.id.slice(1)) || 0)) + 1;
          task.gates = [...task.gates, { id: `g${next}`, kind: 'timer', until: deferred, at: new Date().toISOString(), by }];
        }
        if (existing && JSON.stringify(task) !== before) {
          touch(task, by, 'imported', { from: record.id });
          report.updated.push({ id: task.id, from: record.id });
        }
      } catch (error) {
        report.skipped.push({ line, reason: `${record.id}: ${error.message}` });
      }
    }

    // Relations once every issue has a task.
    for (const { record } of usable) {
      const id = ids.get(record.id);
      if (!id) continue;
      const task = tasks.find(entry => entry.id === id);
      for (const dep of dependencies(record)) {
        const relation = RELATION[dep.type];
        if (!relation) { report.warnings.push(`${record.id}: dependency type ${dep.type} has no ALP relation; skipped`); continue; }
        const other = find(dep.depends_on_id);
        if (!other) { report.warnings.push(`${record.id}: ${dep.type} ${dep.depends_on_id} is not in the file or the project; skipped`); continue; }
        const before = JSON.stringify(task);
        const refused = link(task, relation, other);
        if (refused) report.warnings.push(`${record.id}: ${dep.type} ${dep.depends_on_id} skipped: ${refused}`);
        else if (JSON.stringify(task) !== before) touch(task);
      }
    }
    return report;
  }, { dryRun });
}

/** beads statuses in ALP: closed stays closed, review comes back from metadata, everything else is open again. */
function applyStatus(task, record, alp, by, report) {
  const status = record.status ?? 'open';
  if (status === 'closed') {
    if (task.status === 'closed') return;
    task.status = 'closed';
    task.assignee = null;
    task.closed = alp.closed && typeof alp.closed === 'object'
      ? alp.closed
      : { at: typeof record.closed_at === 'string' ? record.closed_at : new Date().toISOString(), by: 'beads', reason: 'done', ...(typeof record.close_reason === 'string' && record.close_reason ? { summary: record.close_reason } : {}) };
  } else if (alp.status === 'review' && alp.handoff) {
    task.status = 'review';
    task.handoff = alp.handoff;
  } else if (status === 'in_progress' && task.status === 'open') {
    // Nobody in ALP holds it; it is open until main or the user starts it.
    report.warnings.push(`${record.id}: was in progress${record.assignee ? ` with ${record.assignee}` : ''} in beads; imported as open`);
  } else if (!['open', 'in_progress', 'blocked', 'deferred'].includes(status)) {
    report.warnings.push(`${record.id}: beads status ${status} imported as open`);
  }
}
