import { stat } from 'fs/promises';
import { basename, join } from 'path';
import { runTrufflehog } from './adapters/trufflehog.js';
import { runSemgrep } from './adapters/semgrep.js';
import { runClaude } from './adapters/claude.js';
import { runSpectreWithStatus, shouldSkipSpectreFile } from './adapters/spectre.js';
import { runDepDoctor } from './adapters/dep-doctor.js';
import { isDependencyLockfile } from './adapters/dep-doctor-lockfiles.js';
import { debug } from './debug.js';
import { loadScanConfig } from './config.js';
import type { DispatchResult, ScanContext, LineRangesByFile, PullRequestMetadata, SpectreCacheContext, UnifiedDiff } from './types.js';

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function filterOversizedFiles(files: string[], workspacePath: string, maxFileSizeKb: number, signal?: AbortSignal): Promise<{ kept: string[]; oversized: string[] }> {
  const maxBytes = maxFileSizeKb * 1024;
  const kept: string[] = [];
  const oversized: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    try {
      const { size } = await stat(join(workspacePath, file));
      throwIfAborted(signal);
      if (size > maxBytes) {
        console.log(`[dispatcher] skipping ${file} (${Math.round(size / 1024)} KB exceeds ${maxFileSizeKb} KB limit)`);
        oversized.push(file);
      } else {
        kept.push(file);
      }
    } catch {
      throwIfAborted(signal);
      kept.push(file);
    }
  }
  return { kept, oversized };
}

function newModeForFile(diff: UnifiedDiff | undefined, file: string): string | undefined {
  return diff?.files.find(item => item.change.newPath === file)?.change.newMode;
}

export async function dispatch({ scanContext, changedLineRanges, owner, repo, pullRequestMetadata, spectreCacheContext, signal }: {
  scanContext: ScanContext;
  changedLineRanges: LineRangesByFile;
  owner: string;
  repo: string;
  pullRequestMetadata?: PullRequestMetadata;
  spectreCacheContext?: SpectreCacheContext;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  throwIfAborted(signal);
  const { scanWorkspacePath, scanFiles, sourceFiles, repoWorkspacePath, promptFiles, baseSha } = scanContext;
  debug('dispatcher', `running scanners on ${scanFiles?.length ?? 0} file(s)`);

  const scanConfig = await loadScanConfig({ owner, repo });
  throwIfAborted(signal);

  const { kept: eligibleFiles } = await filterOversizedFiles(scanFiles ?? [], repoWorkspacePath, scanConfig.maxFileSizeKb, signal);
  const eligibleFileSet = new Set(eligibleFiles);
  const eligiblePromptFiles = promptFiles.filter(({ file }) => eligibleFileSet.has(file));
  const spectreSizeCandidates = sourceFiles.filter(file =>
    !shouldSkipSpectreFile(file, scanConfig.spectre, newModeForFile(scanContext.unifiedDiff, file))
  );
  const { oversized: oversizedSpectreFiles } = await filterOversizedFiles(
    spectreSizeCandidates,
    repoWorkspacePath,
    scanConfig.maxFileSizeKb,
    signal,
  );
  const oversizedSpectreSet = new Set(oversizedSpectreFiles);
  const eligibleSpectreFiles = sourceFiles.filter(file => !oversizedSpectreSet.has(file));
  const depDoctorCandidates = sourceFiles.filter(file => isDependencyLockfile(basename(file)));
  const { kept: eligibleDepDoctorFiles, oversized: oversizedDepDoctorFiles } = await filterOversizedFiles(
    depDoctorCandidates,
    repoWorkspacePath,
    scanConfig.maxLockfileSizeKb,
    signal,
  );
  const depDoctorBasePaths = Object.fromEntries(
    (scanContext.unifiedDiff?.files ?? [])
      .filter(file =>
        (file.change.status === 'renamed' || file.change.status === 'copied')
        && file.change.newPath !== null
        && file.change.oldPath !== null
      )
      .map(file => [file.change.newPath!, file.change.oldPath!]),
  );

  const [trufflehogResult, semgrepResult, claudeResult, spectreResult, depDoctorResult] = await Promise.all([
    runTrufflehog({ workspacePath: scanWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.trufflehog, signal }),
    // Semgrep needs complete HEAD files for valid syntax; the worker applies the
    // exact changed-line filter before suppression and reporting in diff_only mode.
    runSemgrep({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, toolConfig: scanConfig.semgrep, signal }),
    runClaude({ workspacePath: repoWorkspacePath, changedFiles: eligibleFiles, changedLineRanges, promptFiles: eligiblePromptFiles, toolConfig: scanConfig.claude, signal }),
    runSpectreWithStatus({
      workspacePath: repoWorkspacePath,
      changedFiles: eligibleSpectreFiles,
      changedLineRanges,
      unifiedDiff: scanContext.unifiedDiff,
      pullRequestMetadata,
      cacheContext: spectreCacheContext,
      owner,
      repo,
      toolConfig: scanConfig.spectre,
      signal,
    }),
    runDepDoctor({
      workspacePath: repoWorkspacePath,
      changedFiles: eligibleDepDoctorFiles,
      omittedFiles: oversizedDepDoctorFiles,
      basePaths: depDoctorBasePaths,
      baseSha,
      toolConfig: scanConfig.depDoctor,
      signal,
    }),
  ]);
  throwIfAborted(signal);

  const findings = [
    ...trufflehogResult.findings,
    ...semgrepResult.findings,
    ...claudeResult.findings,
    ...spectreResult.findings,
    ...depDoctorResult.findings,
  ];
  spectreResult.status.oversized = oversizedSpectreFiles.length;
  if (spectreResult.status.outcome !== 'disabled' && oversizedSpectreFiles.length > 0) {
    spectreResult.status.outcome = 'incomplete';
    spectreResult.status.reason ??= 'file-size-limit-exceeded';
  }
  return {
    findings,
    statuses: {
      trufflehog: trufflehogResult.status,
      semgrep: semgrepResult.status,
      claude: claudeResult.status,
      spectre: spectreResult.status,
      'dep-doctor': depDoctorResult.status,
    },
  };
}
