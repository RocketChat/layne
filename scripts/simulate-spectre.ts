import { resolve } from 'path';
import { runSpectreSimulationCorpus } from '../src/spectre-simulator.js';

const fixturePath = resolve(process.argv[2] ?? 'fixtures/spectre-simulations.json');

// Keep stdout as one machine-readable JSON document when DEBUG_MODE is enabled.
console.debug = (...arguments_: unknown[]) => console.error(...arguments_);

try {
  const report = await runSpectreSimulationCorpus(fixturePath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.failed > 0) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    fixturePath,
    total: 0,
    passed: 0,
    failed: 1,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    precision: 0,
    recall: 0,
    f1: 0,
    error: (error as Error).message,
    cases: [],
  })}\n`);
  process.exitCode = 1;
}
