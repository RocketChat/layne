import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep } from './adapters/semgrep.js';
import { runClaude } from './adapters/claude.js';
import { debug } from './debug.js';
import { loadScanConfig } from './config.js';

export async function dispatch({ workspacePath, changedFiles, changedLineRanges, owner, repo }) {
  debug('dispatcher', `running scanners on ${changedFiles?.length ?? 0} file(s)`);

  const scanConfig = await loadScanConfig({ owner, repo });

  const [trufflehogFindings, semgrepFindings, claudeFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles, toolConfig: scanConfig.trufflehog }),
    runSemgrep({ workspacePath, changedFiles, toolConfig: scanConfig.semgrep }),
    runClaude({ workspacePath, changedFiles, changedLineRanges, toolConfig: scanConfig.claude }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...claudeFindings];
}
