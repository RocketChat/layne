import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep }    from './adapters/semgrep.js';
import { debug }         from './debug.js';

/**
 * Dispatcher — runs all configured security tools against the workspace
 * and returns their findings merged into the common format:
 *   { file, line, severity, message, ruleId, tool }
 */
export async function dispatch({ workspacePath, changedFiles }) {
  debug('dispatcher', `running scanners on ${changedFiles?.length ?? 0} file(s)`);
  const [trufflehogFindings, semgrepFindings] = await Promise.all([
    runTrufflehog({ workspacePath, changedFiles }),
    runSemgrep({ workspacePath, changedFiles }),
  ]);

  return [...trufflehogFindings, ...semgrepFindings];
}
