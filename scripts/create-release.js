#!/usr/bin/env node
/**
 * Publish script run by changesets/action after a Version Packages PR is merged.
 * - Creates a GitHub release with an auto-generated changelog
 * - Pushes develop → main to trigger the deploy workflow
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const version = `v${JSON.parse(readFileSync('package.json', 'utf8')).version}`;

console.log(`Creating GitHub release ${version}...`);
execSync(`gh release create ${version} --title "${version}" --generate-notes`, { stdio: 'inherit' });

console.log('Promoting develop → main...');
execSync('git push origin HEAD:main', { stdio: 'inherit' });

console.log(`Released ${version}.`);
