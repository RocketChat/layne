import { describe, expect, it } from 'vitest';
import { analyzeSpectreStructuralSignals, type SpectreStructuralFact } from '../spectre-structural-signals.js';

function kinds(facts: readonly SpectreStructuralFact[]): string[] {
  return [...new Set(facts.map(fact => fact.kind))].sort();
}

const aliases = [
  ['client', 'environment'],
  ['sender', 'variables'],
  ['transport', 'runtime'],
  ['requester', 'configuration'],
  ['outbound', 'processState'],
  ['gateway', 'envStore'],
  ['publish', 'settings'],
  ['upload', 'execution'],
  ['dispatch', 'context'],
  ['forward', 'hostState'],
  ['relay', 'parameters'],
  ['submit', 'runtimeState'],
  ['deliver', 'environmentMap'],
  ['transmit', 'processValues'],
  ['announce', 'variablesMap'],
  ['emitRequest', 'systemState'],
  ['sendPayload', 'hostVariables'],
  ['postData', 'runtimeValues'],
  ['syncRemote', 'processConfig'],
  ['writeRemote', 'environmentValues'],
] as const;

describe('Spectre structural adversarial transformations', () => {
  it('retains JavaScript provenance across alias renames, formatting changes, and textual decoys', async () => {
    for (const [index, [network, environment]] of aliases.entries()) {
      const lines = [
        `import { post as ${network} } from 'axios';`,
        `import { env as ${environment} } from 'node:process';`,
        'const decoy = "fetch(url); eval(payload); process.env.DECOY_TOKEN";',
        `const token = ${environment}.NPM_TOKEN;`,
        `${network}(endpoint, token);`,
        '// require("child_process").exec(decoy);',
      ];
      const content = index % 2 === 0 ? lines.join('\n') : lines.join('\r\n');
      const file = (await analyzeSpectreStructuralSignals([{
        file: `src/${network}.ts`,
        content,
        addedLines: [{ line: 5, content: lines[4]! }],
      }])).files[0]!;

      expect(file.outcome, network).toBe('parsed');
      expect(kinds(file.facts), network).toEqual(['network-access', 'secret-access', 'secret-network-flow']);
      expect(file.facts.find(fact => fact.kind === 'secret-network-flow'), network).toMatchObject({
        startLine: 5,
        intersectsAddedLine: true,
      });
    }
  });

  it('retains Python provenance across alias renames and textual decoys', async () => {
    for (const [network, environment] of aliases) {
      const lines = [
        `from requests import post as ${network}`,
        `from os import environ as ${environment}`,
        'decoy = "requests.post(url); eval(payload); os.environ"',
        `token = ${environment}['PYPI_TOKEN']`,
        `${network}(endpoint, data=token)`,
        '# subprocess.run(decoy)',
      ];
      const file = (await analyzeSpectreStructuralSignals([{
        file: `src/${network}.py`,
        content: lines.join('\n'),
        addedLines: [{ line: 5, content: lines[4]! }],
      }])).files[0]!;

      expect(file.outcome, network).toBe('parsed');
      expect(kinds(file.facts), network).toEqual(['network-access', 'secret-access', 'secret-network-flow']);
      expect(file.facts.find(fact => fact.kind === 'secret-network-flow'), network).toMatchObject({
        startLine: 5,
        intersectsAddedLine: true,
      });
    }
  });

  it('retains Go provenance across package aliases and textual decoys', async () => {
    for (const [network, environment] of aliases) {
      const lines = [
        'package source',
        `import ${network} "net/http"`,
        `import ${environment} "os"`,
        'import "strings"',
        'var decoy = "http.Get(url); exec.Command(payload); os.Getenv(TOKEN)"',
        `func sync(endpoint string) { token := ${environment}.Getenv("GITHUB_TOKEN"); ${network}.Post(endpoint, "text/plain", strings.NewReader(token)) }`,
        '// exec.Command(decoy)',
      ];
      const file = (await analyzeSpectreStructuralSignals([{
        file: `src/${network}.go`,
        content: lines.join('\n'),
        addedLines: [{ line: 6, content: lines[5]! }],
      }])).files[0]!;

      expect(file.outcome, network).toBe('parsed');
      expect(kinds(file.facts), network).toEqual(['network-access', 'secret-access', 'secret-network-flow']);
      expect(file.facts.find(fact => fact.kind === 'secret-network-flow'), network).toMatchObject({
        startLine: 6,
        intersectsAddedLine: true,
      });
    }
  });
});
