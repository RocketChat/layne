#!/usr/bin/env node
/**
 * Replay a webhook fixture against your local Layne server.
 *
 * Usage:
 *   node scripts/replay-webhook.js [fixture-path] [server-url]
 *
 * Defaults:
 *   fixture-path  fixtures/webhooks/pr_opened.json
 *   server-url    http://localhost:3000
 *
 * Examples:
 *   npm run replay
 *   npm run replay fixtures/webhooks/pr_synchronize.json
 *   npm run replay fixtures/webhooks/pr_opened.json http://localhost:3001
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturePath = process.argv[2]
  ?? resolve(__dirname, '../fixtures/webhooks/pr_opened.json');

const serverUrl = (process.argv[3] ?? 'http://localhost:3000') + '/webhook';

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    '[replay] Error: GITHUB_WEBHOOK_SECRET is not set.\n' +
    '         Copy .env.example to .env and fill in the required values.'
  );
  process.exit(1);
}

// Read the raw bytes of the fixture file.
// The HMAC must be computed over the exact bytes that will be sent in the
// request body. Never JSON.parse + JSON.stringify — whitespace normalisation
// would change the bytes and invalidate the signature.
let rawBody: Buffer;
try {
  rawBody = readFileSync(fixturePath);
} catch (err) {
  console.error(`[replay] Error: could not read fixture file: ${fixturePath}`);
  console.error(`         ${(err as NodeJS.ErrnoException).message}`);
  process.exit(1);
}

const signature = 'sha256=' + createHmac('sha256', secret)
  .update(rawBody)
  .digest('hex');

console.log(`[replay] fixture  → ${fixturePath}`);
console.log(`[replay] target   → ${serverUrl}`);

let res: Response;
try {
  res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': signature,
    },
    body: rawBody,
  });
} catch (err) {
  console.error(`[replay] Error: could not reach the server at ${serverUrl}`);
  console.error(`         ${(err as Error).message}`);
  console.error('         Is the server running? Try: npm start');
  process.exit(1);
}

const text = await res.text();
console.log(`[replay] response → ${res.status} ${text}`);
