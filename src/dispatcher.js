import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';
import { runClaude }     from './adapters/claude.js';
import { debug }         from './debug.js';
import { loadScanConfig } from './config.js';

/**
 * Dispatcher — runs all configured security tools against the workspace
 * and returns their findings merged into the common format:
 *   { file, line, severity, message, ruleId, tool }
 */
export async function dispatch({ workspacePath, changedFiles, baseSha, baseRef, labels, owner, repo }) {
  debug('dispatcher', `running scanners on ${changedFiles?.length ?? 0} file(s)`);

  const scanConfig = await loadScanConfig({ owner, repo });

  const [trufflehogFindings, semgrepFindings, claudeFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles, toolConfig: scanConfig.trufflehog }),
    runSemgrep({ workspacePath, changedFiles, toolConfig: scanConfig.semgrep }),
    runClaude({ workspacePath, changedFiles, toolConfig: scanConfig.claude }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings, ...claudeFindings];
}
