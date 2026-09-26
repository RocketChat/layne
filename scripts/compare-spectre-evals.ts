import { readFile, writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import type { SpectreEvaluationFinding, SpectreEvaluationResult } from './evaluate-spectre.js';

interface EvaluationReportInput {
  evaluator?: string;
  model?: string | null;
  results: SpectreEvaluationResult[];
}

interface CaseCounts {
  falsePositives: number;
  falseNegatives: number;
}

export interface SpectreEvaluationComparison {
  version: 1;
  before: { evaluator: string | null; model: string | null; results: number };
  after: { evaluator: string | null; model: string | null; results: number };
  paired: number;
  unpairedBefore: string[];
  unpairedAfter: string[];
  delta: {
    falsePositives: number;
    falseNegatives: number;
    malformed: number;
    errors: number;
    passed: number;
  };
  changed: Array<{
    key: string;
    before: CaseCounts & { passed: boolean; malformed: boolean; error: boolean; selectedFiles: string[] };
    after: CaseCounts & { passed: boolean; malformed: boolean; error: boolean; selectedFiles: string[] };
    routingSelectionChanged: boolean;
  }>;
}

function pairKey(result: SpectreEvaluationResult): string {
  return `${result.baseCaseId ?? result.id}#${result.runIndex ?? 1}`;
}

function findingKeys(result: SpectreEvaluationResult, side: 'expected' | 'actual'): string[] {
  const findings = (side === 'expected' ? result.expectedFindings : result.actualFindings) as SpectreEvaluationFinding[] | undefined;
  return findings === undefined
    ? (side === 'expected' ? result.expectedRuleIds : result.actualRuleIds).map(ruleId => `rule:${ruleId}`)
    : findings.map(finding => `${finding.file}\0${finding.ruleId}`);
}

function counts(result: SpectreEvaluationResult): CaseCounts {
  const remaining = findingKeys(result, 'actual');
  let truePositives = 0;
  for (const expected of findingKeys(result, 'expected')) {
    const index = remaining.indexOf(expected);
    if (index >= 0) {
      truePositives++;
      remaining.splice(index, 1);
    }
  }
  return {
    falsePositives: remaining.length,
    falseNegatives: findingKeys(result, 'expected').length - truePositives,
  };
}

function snapshot(result: SpectreEvaluationResult): CaseCounts & {
  passed: boolean;
  malformed: boolean;
  error: boolean;
  selectedFiles: string[];
} {
  return {
    ...counts(result),
    passed: result.passed,
    malformed: result.malformed,
    error: result.error !== undefined,
    selectedFiles: result.routing?.selectedFiles ?? [],
  };
}

function report(value: unknown, label: string): EvaluationReportInput {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { results?: unknown }).results)) {
    throw new Error(`${label} is not a Spectre evaluation report`);
  }
  return value as EvaluationReportInput;
}

export function compareSpectreEvaluationReports(beforeValue: unknown, afterValue: unknown): SpectreEvaluationComparison {
  const before = report(beforeValue, 'before report');
  const after = report(afterValue, 'after report');
  const beforeByKey = new Map(before.results.map(result => [pairKey(result), result]));
  const afterByKey = new Map(after.results.map(result => [pairKey(result), result]));
  const pairedKeys = [...beforeByKey.keys()].filter(key => afterByKey.has(key)).sort();
  const changed: SpectreEvaluationComparison['changed'] = [];
  const delta = { falsePositives: 0, falseNegatives: 0, malformed: 0, errors: 0, passed: 0 };

  for (const key of pairedKeys) {
    const beforeResult = beforeByKey.get(key)!;
    const afterResult = afterByKey.get(key)!;
    const beforeSnapshot = snapshot(beforeResult);
    const afterSnapshot = snapshot(afterResult);
    delta.falsePositives += afterSnapshot.falsePositives - beforeSnapshot.falsePositives;
    delta.falseNegatives += afterSnapshot.falseNegatives - beforeSnapshot.falseNegatives;
    delta.malformed += Number(afterSnapshot.malformed) - Number(beforeSnapshot.malformed);
    delta.errors += Number(afterSnapshot.error) - Number(beforeSnapshot.error);
    delta.passed += Number(afterSnapshot.passed) - Number(beforeSnapshot.passed);
    const routingSelectionChanged = JSON.stringify(beforeSnapshot.selectedFiles) !== JSON.stringify(afterSnapshot.selectedFiles);
    if (routingSelectionChanged || JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot)) {
      changed.push({ key, before: beforeSnapshot, after: afterSnapshot, routingSelectionChanged });
    }
  }

  return {
    version: 1,
    before: { evaluator: before.evaluator ?? null, model: before.model ?? null, results: before.results.length },
    after: { evaluator: after.evaluator ?? null, model: after.model ?? null, results: after.results.length },
    paired: pairedKeys.length,
    unpairedBefore: [...beforeByKey.keys()].filter(key => !afterByKey.has(key)).sort(),
    unpairedAfter: [...afterByKey.keys()].filter(key => !beforeByKey.has(key)).sort(),
    delta,
    changed,
  };
}

export async function runSpectreEvaluationComparison(args: readonly string[]): Promise<void> {
  const [beforePath, afterPath, outputPath] = args;
  if (!beforePath || !afterPath || args.length > 3) {
    throw new Error('Usage: npm run spectre:eval:compare -- <before-report.json> <after-report.json> [output.json]');
  }
  const [before, after] = await Promise.all([
    readFile(beforePath, 'utf8').then(JSON.parse),
    readFile(afterPath, 'utf8').then(JSON.parse),
  ]);
  const rendered = `${JSON.stringify(compareSpectreEvaluationReports(before, after), null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, rendered);
  process.stdout.write(rendered);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSpectreEvaluationComparison(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
