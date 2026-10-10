import { deleteEntry, duplicateEntry, getEntry, listEntries, renameEntry, saveEntry, setGivenSkills } from '../../../src/core/library-edit.js';
import { testEntry } from '../../../src/client/library-test.js';
import { alpHome } from '../../../src/client/index.js';
import { languageSetting, setLanguage } from '../../../src/core/user-settings.js';
import type { PluginServerContext } from './compat.js';
import { templates } from './mapping.js';
import { projectOf } from './tasks.js';
import { languageGet, languageSet, libraryDelete, libraryDuplicate, libraryGet, libraryList, libraryRename, librarySave, librarySkills, libraryTest } from '../shared/library.js';

/** Where an edit reads and writes: the user's library, and the workspace's project when there is one. */
async function where(directory?: string) {
  const root = directory ? await projectOf(directory) : null;
  return { root: root ?? undefined, library: alpHome(), templates };
}

/** The ALP settings screen's server side (ALPD §43): the same core functions as the CLI, run as the user. */
export function registerLibraryRpc(server: PluginServerContext) {
  server.handle(libraryList, async ({ directory, kind }) => {
    const options = await where(directory);
    return { projectRoot: options.root ?? null, library: options.library, entries: await listEntries(kind, options) };
  });
  server.handle(libraryGet, async ({ directory, kind, name, scope }) => getEntry(kind, name, { ...await where(directory), ...(scope ? { scope } : {}) }));
  server.handle(librarySave, async ({ directory, kind, name, scope, content, revision }) => saveEntry(kind, name, content, { ...await where(directory), scope, ...(revision !== undefined ? { revision } : {}) }));
  server.handle(librarySkills, async ({ agent, skills }) => setGivenSkills(agent, skills, { library: alpHome() }));
  server.handle(languageGet, async () => languageSetting(alpHome()));
  server.handle(languageSet, async ({ language }) => setLanguage(alpHome(), language));
  server.handle(libraryDelete, async ({ directory, kind, name, scope, revision }) => deleteEntry(kind, name, { ...await where(directory), scope, ...(revision !== undefined ? { revision } : {}) }));
  server.handle(libraryDuplicate, async ({ directory, kind, from, to, scope }) => duplicateEntry(kind, from, to, { ...await where(directory), scope }));
  server.handle(libraryRename, async ({ directory, kind, from, to, scope }) => renameEntry(kind, from, to, { ...await where(directory), scope }));
  server.handle(libraryTest, async ({ directory, kind, name, scope }) => {
    const { payload: _payload, kind: _kind, name: _name, source: _source, ...result } = await testEntry(kind, name, { ...await where(directory), ...(scope ? { scope } : {}) }) as Record<string, any>;
    return result as any;
  });
}
