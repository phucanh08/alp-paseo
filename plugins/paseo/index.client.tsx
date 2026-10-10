import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TasksPanel, TasksScreen } from './client/tasks-panel';
import { TASKS_SCREEN, addTaskPills, tasksScreen } from './client/task-pills';
import { LibrarySettings, ProjectLibraryPanel } from './client/library';

/**
 * ALP's client contributions: the Tasks panel of a workspace's project, the Tasks screen
 * with a pill in each ALP agent's composer that opens it (phones cannot reach panels),
 * the ALP settings screen for the user's library, and the "ALP project" panel for a
 * project's overrides.
 */
export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({ id: 'alp-tasks', title: 'Tasks', icon: 'ListTodo', context: 'workspace', Component: TasksPanel });
  const removeScreen = client.addScreen({ id: TASKS_SCREEN, title: params => params.taskId ? `ALP task ${params.taskId}` : 'ALP tasks', Component: TasksScreen });
  const removePills = addTaskPills(client);
  const removeCommand = client.addCommandCenterItem({
    id: 'alp-open-tasks',
    title: 'Open ALP tasks',
    icon: 'ListTodo',
    keywords: ['tasks', 'todo', 'alp'],
    context: 'workspace',
    onSelect({ openPanel }) { openPanel('alp-tasks'); },
  });
  const removeScreenCommand = client.addCommandCenterItem({
    id: 'alp-open-tasks-screen',
    title: 'Open ALP tasks full screen',
    icon: 'ListTodo',
    keywords: ['tasks', 'todo', 'alp', 'phone'],
    context: 'workspace',
    onSelect({ workspace, openScreen }) { openScreen(tasksScreen(workspace.id, workspace.directory || workspace.projectRootPath)); },
  });
  // "/tasks" opens the board, "/tasks t-0003" that task.
  const removeSlash = client.addSlashCommand({
    name: 'tasks',
    description: 'Open the ALP tasks of this project',
    argumentHint: '[task id]',
    context: 'agent',
    onSubmit({ workspace, args, openScreen }) { openScreen(tasksScreen(workspace.id, workspace.directory || workspace.projectRootPath, args.trim() || undefined)); },
  });
  const removeSettings = client.addSettingsScreen({ id: 'alp-settings', title: 'ALP', icon: 'Bot', Component: LibrarySettings });
  const removeProject = client.addWorkspacePanel({ id: 'alp-project', title: 'ALP project', icon: 'Bot', context: 'workspace', Component: ProjectLibraryPanel });
  return () => { removePanel(); removeScreen(); removePills(); removeCommand(); removeScreenCommand(); removeSlash(); removeSettings(); removeProject(); };
}
