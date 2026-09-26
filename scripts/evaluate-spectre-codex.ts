/** Manual, local-only Spectre semantic evaluation through the Codex CLI. */
import { writeFile } from 'fs/promises';
import { pathToFileURL } from 'url';
import { loadScanConfig } from '../src/config.js';
import {
  assertManualSpectreEvaluation,
  addEvaluationStability,
  buildEvaluationReproducibility,
  createEvaluationResult,
  evaluationAstModeFromEnv,
  evaluationConfigWithAstMode,
  evaluateSpectreThresholds,
  evaluationThresholdsFromEnv,
  loadEvaluationCases,
  resolveEvaluationFiles,
  runProductionEvaluationCase,
  scoreSpectreEvaluation,
  type SpectreEvaluationResult,
} from './evaluate-spectre.js';
import { createCodexCliSpectreTransport } from './spectre-transports/codex-cli.js';

export function assertManualCodexEvaluation(env: NodeJS.ProcessEnv): void {
  assertManualSpectreEvaluation(env);
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number.parseInt(env.SPECTRE_EVAL_TIMEOUT_MS ?? '45000', 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error('SPECTRE_EVAL_TIMEOUT_MS must be an integer from 1 to 300000');
  }
  return timeoutMs;
}

export async function runCodexEvaluation(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertManualCodexEvaluation(env);
  const outputPath = env.SPECTRE_EVAL_OUTPUT ?? 'spectre-eval-codex-report.json';
  const model = env.SPECTRE_EVAL_CODEX_MODEL ?? env.SPECTRE_EVAL_MODEL;
  const timeoutMs = timeoutFromEnv(env);
  const loaded = await loadEvaluationCases(env);
  const scanConfig = await loadScanConfig({
    owner: env.SPECTRE_EVAL_OWNER ?? 'example-org',
    repo: env.SPECTRE_EVAL_REPO ?? 'example-repo',
  });
  const astModeOverride = evaluationAstModeFromEnv(env);
  const evaluationConfig = evaluationConfigWithAstMode(scanConfig.spectre, astModeOverride);
  const transport = createCodexCliSpectreTransport({ model, timeoutMs });
  const results: SpectreEvaluationResult[] = [];

  for (const test of loaded.corpus) {
    for (let runIndex = 1; runIndex <= loaded.repeats; runIndex++) {
      console.log(`Evaluating ${test.id} run ${runIndex}/${loaded.repeats} with Codex${model ? ` (${model})` : ''}...`);
      try {
        const files = await resolveEvaluationFiles(test, loaded.sourceRoot);
        const parsed = await runProductionEvaluationCase(test, files, scanConfig.spectre, transport, astModeOverride);
        results.push(createEvaluationResult(test, parsed.actualRuleIds, {
          runIndex,
          malformed: parsed.malformed,
          expectedFindings: parsed.expectedFindings,
          actualFindings: parsed.actualFindings,
          routing: parsed.routing,
        }));
      } catch (error) {
        results.push(createEvaluationResult(test, [], {
          runIndex,
          error: error instanceof Error ? error.name : 'EvaluationError',
        }));
      }
    }
  }

  addEvaluationStability(results);
  const score = scoreSpectreEvaluation(results);
  const thresholds = evaluationThresholdsFromEnv(env);
  const thresholdFailures = evaluateSpectreThresholds(score, thresholds);
  const reproducibility = await buildEvaluationReproducibility({
    corpusSha256: loaded.corpusSha256,
    config: evaluationConfig,
    astMode: evaluationConfig.astSignals.mode,
    model,
    cliTimeoutMs: timeoutMs,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    evaluator: 'codex',
    corpusPath: loaded.corpusPath,
    sourceRoot: loaded.sourceRoot,
    model: model ?? null,
    timeoutMs,
    offset: loaded.offset,
    limit: loaded.limit,
    repeats: loaded.repeats,
    tagFilter: loaded.tagFilter,
    tagMatchedCases: loaded.tagMatchedCases,
    selectedBaseCases: loaded.corpus.length,
    totalCorpusCases: loaded.fullCorpus.length,
    reproducibility,
    ...score,
    thresholds,
    thresholdFailures,
    results,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Spectre Codex evaluation: ${score.passed}/${score.total} cases passed; `
      + `precision=${score.aggregate.precision.toFixed(3)} recall=${score.aggregate.recall.toFixed(3)} `
      + `F1=${score.aggregate.f1.toFixed(3)} FP=${score.aggregate.falsePositives} `
      + `FN=${score.aggregate.falseNegatives} malformed=${score.malformed} errors=${score.errors}; `
      + `report written to ${outputPath}`,
  );
  if (thresholdFailures.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCodexEvaluation().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
