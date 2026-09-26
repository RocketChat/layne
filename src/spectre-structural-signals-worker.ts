import { parentPort, workerData } from 'node:worker_threads';
import {
  analyzeSpectreStructuralSignals,
  type SpectreStructuralInputFile,
  type SpectreStructuralLimits,
} from './spectre-structural-signals.js';

interface StructuralWorkerData {
  files: SpectreStructuralInputFile[];
  limits: SpectreStructuralLimits;
}

const data = workerData as StructuralWorkerData;

const port = parentPort;

if (port) {
  void analyzeSpectreStructuralSignals(data.files, { limits: data.limits })
    .then(result => port.postMessage(result))
    .catch(() => {
      process.exitCode = 1;
    });
}
