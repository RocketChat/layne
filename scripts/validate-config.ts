#!/usr/bin/env node
/**
 * Validates config/layne.json and exits with code 1 if there are errors.
 * Run via: npm run validate-config
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from '../src/config-validator.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config', 'layne.json');

let raw: unknown;
try {
  raw = JSON.parse(await readFile(configPath, 'utf8'));
} catch (err) {
  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr.code === 'ENOENT') {
    console.error(`✗ config/layne.json not found at ${configPath}`);
  } else if (err instanceof SyntaxError) {
    console.error(`✗ config/layne.json is not valid JSON: ${err.message}`);
  } else {
    console.error(`✗ Failed to read config/layne.json: ${nodeErr.message}`);
  }
  process.exit(1);
}

const result = validateConfig(raw);

if (result.valid) {
  const repoCount = Object.keys(raw as Record<string, unknown>).filter(k => k !== '$global').length;
  console.log(`✓ config/layne.json is valid (${repoCount} repo(s) configured)`);
  process.exit(0);
} else {
  console.error(`✗ config/layne.json has ${result.errors.length} error(s):\n`);
  for (const err of result.errors) {
    console.error(`  • ${err}`);
  }
  process.exit(1);
}
