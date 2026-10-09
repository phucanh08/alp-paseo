import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TasksPanel } from './client/tasks-panel';

/** ALP's client contributions: the Tasks panel of a workspace's project. */
export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({ id: 'alp-tasks', title: 'Tasks', icon: 'ListTodo', context: 'workspace', Component: TasksPanel });
  const removeCommand = client.addCommandCenterItem({
    id: 'alp-open-tasks',
    title: 'Open ALP tasks',
    icon: 'ListTodo',
    keywords: ['tasks', 'todo', 'alp'],
    context: 'workspace',
    onSelect({ openPanel }) { openPanel('alp-tasks'); },
  });
  return () => { removePanel(); removeCommand(); };
}
