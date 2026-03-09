import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';

/**
 * Dispatcher — runs all configured security tools against the workspace
 * and returns their findings merged into the common format:
 *   { file, line, severity, message, ruleId, tool }
 */
export async function dispatch({ workspacePath, changedFiles }) {
  const [trufflehogFindings, semgrepFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles }),
    runSemgrep({ workspacePath, baseline: 'FETCH_HEAD' }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings];
}
