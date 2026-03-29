import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep } from './adapters/semgrep.js';
import { runClaude } from './adapters/claude.js';
import { debug } from './debug.js';
import { loadScanConfig } from './config.js';
import type { ScanContext, LineRangesByFile, RawFinding } from './types.js';

export async function dispatch({ scanContext, changedLineRanges, owner, repo }: {
  scanContext: ScanContext;
  changedLineRanges: LineRangesByFile;
  owner: string;
  repo: string;
}): Promise<RawFinding[]> {
  const { scanWorkspacePath, scanFiles, repoWorkspacePath, promptFiles } = scanContext;
  debug('dispatcher', `running scanners on ${scanFiles?.length ?? 0} file(s)`);

  const scanConfig = await loadScanConfig({ owner, repo });

  const [trufflehogFindings, semgrepFindings, claudeFindings] = await Promise.all([
    runTrufflehog({ workspacePath: scanWorkspacePath, changedFiles: scanFiles, toolConfig: scanConfig.trufflehog }),
    runSemgrep({ workspacePath: scanWorkspacePath, changedFiles: scanFiles, toolConfig: scanConfig.semgrep }),
    runClaude({ workspacePath: repoWorkspacePath, changedFiles: scanFiles, changedLineRanges, promptFiles, toolConfig: scanConfig.claude }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...claudeFindings];
}
