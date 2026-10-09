import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TasksPanel } from './client/tasks-panel';
import { LibrarySettings, ProjectLibraryPanel } from './client/library';

/**
 * ALP's client contributions: the Tasks panel of a workspace's project, the ALP settings
 * screen for the user's library, and the "ALP project" panel for a project's overrides.
 */
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
  const removeSettings = client.addSettingsScreen({ id: 'alp-settings', title: 'ALP', icon: 'Bot', Component: LibrarySettings });
  const removeProject = client.addWorkspacePanel({ id: 'alp-project', title: 'ALP project', icon: 'Bot', context: 'workspace', Component: ProjectLibraryPanel });
  return () => { removePanel(); removeCommand(); removeSettings(); removeProject(); };
}
