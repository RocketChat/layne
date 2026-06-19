import { stat } from 'fs/promises';
import { join } from 'path';
import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep } from './adapters/semgrep.js';
import { runClaude } from './adapters/claude.js';
import { runSpectre } from './adapters/spectre.js';
import { runDepDoctor } from './adapters/dep-doctor.js';
import { debug } from './debug.js';
import { loadScanConfig } from './config.js';
import type { ScanContext, LineRangesByFile, RawFinding } from './types.js';

async function filterOversizedFiles(files: string[], workspacePath: string, maxFileSizeKb: number): Promise<string[]> {
  const maxBytes = maxFileSizeKb * 1024;
  const kept: string[] = [];
  for (const file of files) {
    try {
      const { size } = await stat(join(workspacePath, file));
      if (size > maxBytes) {
        console.log(`[dispatcher] skipping ${file} (${Math.round(size / 1024)} KB exceeds ${maxFileSizeKb} KB limit)`);
      } else {
        kept.push(file);
      }
    } catch {
      kept.push(file);
    }
  }
  return kept;
}

export async function dispatch({ scanContext, changedLineRanges, owner, repo }: {
  scanContext: ScanContext;
  changedLineRanges: LineRangesByFile;
  owner: string;
  repo: string;
}): Promise<RawFinding[]> {
  const { scanWorkspacePath, scanFiles, repoWorkspacePath, promptFiles, baseSha } = scanContext;
  debug('dispatcher', `running scanners on ${scanFiles?.length ?? 0} file(s)`);

  const scanConfig = await loadScanConfig({ owner, repo });

  const eligibleFiles = await filterOversizedFiles(scanFiles ?? [], repoWorkspacePath, scanConfig.maxFileSizeKb);

  const [trufflehogFindings, semgrepFindings, claudeFindings, spectreFindings, depDoctorFindings] = await Promise.all([
    runTrufflehog({ workspacePath: scanWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.trufflehog }),
    runSemgrep({ workspacePath: scanWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.semgrep }),
    runClaude({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, changedLineRanges, promptFiles, toolConfig: scanConfig.claude }),
    runSpectre({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, changedLineRanges, promptFiles, toolConfig: scanConfig.spectre }),
    runDepDoctor({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, baseSha, toolConfig: scanConfig.depDoctor }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...claudeFindings, ...spectreFindings, ...depDoctorFindings];
}
