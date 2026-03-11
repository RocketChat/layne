#!/usr/bin/env node
/**
 * Validates config/repos.json and exits with code 1 if there are errors.
 * Run via: npm run validate-config
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from '../src/config-validator.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'config', 'repos.json');

let raw;
try {
  raw = JSON.parse(await readFile(configPath, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`✗ config/repos.json not found at ${configPath}`);
  } else if (err instanceof SyntaxError) {
    console.error(`✗ config/repos.json is not valid JSON: ${err.message}`);
  } else {
    console.error(`✗ Failed to read config/repos.json: ${err.message}`);
  }
  process.exit(1);
}

const result = validateConfig(raw);

if (result.valid) {
  const repoCount = Object.keys(raw).filter(k => k !== '$global').length;
  console.log(`✓ config/repos.json is valid (${repoCount} repo(s) configured)`);
  process.exit(0);
} else {
  console.error(`✗ config/repos.json has ${result.errors.length} error(s):\n`);
  for (const err of result.errors) {
    console.error(`  • ${err}`);
  }
  process.exit(1);
}
