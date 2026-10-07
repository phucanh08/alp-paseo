#!/usr/bin/env node
import { initProject } from './core/init.js';
import { upgradeProject } from './core/upgrade.js';

const [command, ...args] = process.argv.slice(2);
if (!['init', 'upgrade'].includes(command) || args.length > 1) {
  console.error('Usage: alp <init|upgrade> [directory]');
  process.exitCode = 1;
} else {
  try {
    const result = await (command === 'upgrade' ? upgradeProject : initProject)(args[0] ?? process.cwd());
    console.log(`ALP initialized: ${result.created.length} files created, ${result.preserved.length} existing files preserved.`);
    if ('updated' in result) {
      console.log(`ALP upgraded: ${result.updated.length} files updated.${result.backup ? ` Backup: ${result.backup}` : ''}`);
      if (result.customInstructions.length) console.log(`Custom instructions preserved; reconcile with templates if needed: ${result.customInstructions.join(', ')}`);
      if (result.removed.length) console.log(`Retired skills archived: ${result.removed.join(', ')}`);
      if (result.customSkills.length) console.log(`Customized retired skills preserved for review: ${result.customSkills.join(', ')}`);
    }
  } catch (error) {
    console.error(`ALP initialization failed: ${error.message}`);
    process.exitCode = 1;
  }
}
