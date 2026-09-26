import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  addedLinesFromGitHubPatch,
  aggregateSpectreRoutingScores,
  scoreSpectreRoutingSelection,
  type SpectreRoutingSelectionScore,
} from '../src/spectre-routing-evaluation.js';
import { routeSpectreSignals } from '../src/spectre-routing.js';
import { shouldSkipSpectreFile, type SpectreSignalInputFile } from '../src/spectre-signals.js';
import type { SpectreConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);
const MAX_GITHUB_OUTPUT_BYTES = 32 * 1024 * 1024;

interface PullRequestRoutingFixture {
  id: string;
  repository: string;
  pullRequest: number;
  url: string;
  title: string;
  baseSha: string;
  headSha: string;
  caps: number[];
  relevantFiles: string[];
  labelRationale: string;
}

interface GitHubCompareFile {
  filename: string;
  status: string;
  sha: string;
  patch?: string;
}

interface GitHubCompareResponse {
  files?: GitHubCompareFile[];
}

interface GitHubBlobResponse {
  content?: string;
  encoding?: string;
  size?: number;
}

interface RoutingReplayCase {
  id: string;
  pullRequest: number;
  cap: number;
  eligibleFiles: number;
  relevantFiles: string[];
  lexicalSelected: string[];
  augmentedSelected: string[];
  structuralOutcome: string;
  structuralOutcomes: Record<string, number>;
  score: SpectreRoutingSelectionScore;
}

interface PullRequestReplay {
  id: string;
  repository: string;
  pullRequest: number;
  url: string;
  title: string;
  baseSha: string;
  headSha: string;
  labelRationale: string;
  changedFiles: number;
  eligibleFiles: number;
  cases: RoutingReplayCase[];
}

async function ghJson<T>(endpoint: string): Promise<T> {
  const { stdout } = await execFileAsync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: MAX_GITHUB_OUTPUT_BYTES,
  });
  return JSON.parse(stdout) as T;
}

function assertFixture(value: unknown, index: number): asserts value is PullRequestRoutingFixture {
  const fixture = value as Partial<PullRequestRoutingFixture>;
  const sha = /^[0-9a-f]{40}$/;
  if (typeof fixture !== 'object' || fixture === null
    || typeof fixture.id !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fixture.repository ?? '')
    || !Number.isSafeInteger(fixture.pullRequest) || (fixture.pullRequest ?? 0) < 1
    || typeof fixture.url !== 'string'
    || typeof fixture.title !== 'string'
    || !sha.test(fixture.baseSha ?? '')
    || !sha.test(fixture.headSha ?? '')
    || !Array.isArray(fixture.caps) || fixture.caps.length === 0
    || fixture.caps.some(cap => !Number.isSafeInteger(cap) || cap < 1 || cap > 30)
    || !Array.isArray(fixture.relevantFiles) || fixture.relevantFiles.length === 0
    || fixture.relevantFiles.some(file => typeof file !== 'string' || file.length === 0)
    || typeof fixture.labelRationale !== 'string' || fixture.labelRationale.length === 0) {
    throw new Error(`Invalid PR routing fixture at index ${index}`);
  }
}

async function loadFixtures(path: string | URL): Promise<PullRequestRoutingFixture[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('PR routing manifest must be a non-empty array');
  parsed.forEach(assertFixture);
  return parsed;
}

async function fetchBlob(repository: string, sha: string): Promise<string> {
  const blob = await ghJson<GitHubBlobResponse>(`repos/${repository}/git/blobs/${sha}`);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`GitHub returned an unsupported blob representation for ${sha}`);
  }
  return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

async function mapConcurrent<T, U>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function routingConfig(fileCap: number): SpectreConfig {
  return {
    enabled: true,
    model: 'routing-replay',
    fileCap,
    secondaryFileCap: 0,
    astSignals: {
      mode: 'shadow',
      maxFiles: 200,
      maxTotalBytes: 2 * 1024 * 1024,
      timeoutSeconds: 3,
    },
  };
}

async function replayFixture(fixture: PullRequestRoutingFixture): Promise<PullRequestReplay> {
  const comparison = await ghJson<GitHubCompareResponse>(
    `repos/${fixture.repository}/compare/${fixture.baseSha}...${fixture.headSha}`,
  );
  const changed = comparison.files;
  if (!changed) throw new Error(`GitHub comparison omitted files for ${fixture.id}`);
  const candidates = changed.filter(file => file.status !== 'removed' && !shouldSkipSpectreFile(file.filename, routingConfig(20)));
  const known = new Set(candidates.map(file => file.filename));
  const missingLabels = fixture.relevantFiles.filter(file => !known.has(file));
  if (missingLabels.length > 0) throw new Error(`${fixture.id} has missing or ineligible labels: ${missingLabels.join(', ')}`);

  const inputs = await mapConcurrent(candidates, 6, async (file): Promise<SpectreSignalInputFile> => {
    const content = await fetchBlob(fixture.repository, file.sha);
    if (file.patch === undefined) throw new Error(`GitHub comparison omitted the patch for ${fixture.id}: ${file.filename}`);
    return {
      file: file.filename,
      content,
      addedLines: addedLinesFromGitHubPatch(file.patch),
    };
  });

  const cases: RoutingReplayCase[] = [];
  for (const cap of fixture.caps) {
    const routed = await routeSpectreSignals({ files: inputs, config: routingConfig(cap) });
    const augmentedSelected = routed.augmentedSelection?.selected;
    if (!augmentedSelected) throw new Error(`Structural routing did not produce an augmented selection for ${fixture.id}`);
    cases.push({
      id: fixture.id,
      pullRequest: fixture.pullRequest,
      cap,
      eligibleFiles: inputs.length,
      relevantFiles: fixture.relevantFiles,
      lexicalSelected: routed.lexicalSelection.selected,
      augmentedSelected,
      structuralOutcome: routed.diagnostics.outcome,
      structuralOutcomes: routed.diagnostics.outcomes,
      score: scoreSpectreRoutingSelection(fixture.relevantFiles, routed.lexicalSelection.selected, augmentedSelected),
    });
  }

  return {
    id: fixture.id,
    repository: fixture.repository,
    pullRequest: fixture.pullRequest,
    url: fixture.url,
    title: fixture.title,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    labelRationale: fixture.labelRationale,
    changedFiles: changed.length,
    eligibleFiles: inputs.length,
    cases,
  };
}

export async function runSpectrePullRequestRoutingReplay(args: readonly string[]): Promise<void> {
  if (args.length < 1 || args.length > 2) {
    throw new Error('Usage: npm run spectre:replay:prs -- manifest.json [output.json]');
  }
  const manifest = args[0]!;
  const fixtures = await loadFixtures(manifest);
  const pullRequests: PullRequestReplay[] = [];
  for (const fixture of fixtures) pullRequests.push(await replayFixture(fixture));
  const scores = pullRequests.flatMap(pullRequest => pullRequest.cases.map(item => item.score));
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      providerIndependent: true,
      source: 'GitHub compare API and immutable git blobs',
      selection: 'lexical versus AST-augmented shadow routing',
      secondaryFileCap: 0,
      astLimits: routingConfig(20).astSignals,
    },
    aggregate: aggregateSpectreRoutingScores(scores),
    pullRequests,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args[1]) await writeFile(args[1], rendered);
  process.stdout.write(rendered);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSpectrePullRequestRoutingReplay(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
