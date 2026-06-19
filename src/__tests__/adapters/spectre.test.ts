import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCompleteSimple = vi.fn();
const mockGetModel       = vi.fn(() => ({}));
const mockReadFile       = vi.fn();

vi.mock('@mariozechner/pi-ai', () => ({
  getModel:       mockGetModel,
  completeSimple: mockCompleteSimple,
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    spectre: Object.freeze({
      enabled:          false,
      model:            'claude-haiku-4-5-20251001',
      fileCap:          20,
      secondaryFileCap: 20,
      maxDiffLines:     400,
      minSeverity:      'high',
      concurrency:      5,
      skipPaths:        [],
      skipExtensions:   [],
      prompt:           null,
      boostPatterns:    [],
    }),
  }),
}));

const { runSpectre } = await import('../../adapters/spectre.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = '/tmp/ws';

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled:          true,
    provider:         'anthropic',
    model:            'claude-haiku-4-5-20251001',
    fileCap:          20,
    secondaryFileCap: 20,
    maxDiffLines:     400,
    minSeverity:      'high' as const,
    concurrency:      1,
    skipPaths:        [],
    skipExtensions:   [],
    prompt:           null,
    boostPatterns:    [],
    ...overrides,
  };
}

// Clean LLM response — no findings.
function noFindings() {
  return {
    content: [{ type: 'text', text: '{"findings":[]}' }],
  };
}

// Generate file names for testing.
function files(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}.js`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSpectre()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModel.mockReturnValue({});
    mockCompleteSimple.mockResolvedValue(noFindings());
    // By default files have no suspicious keywords → tier3
    mockReadFile.mockResolvedValue('const x = 1;');
  });

  it('returns empty when disabled', async () => {
    const findings = await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/a.js'],
      toolConfig:    enabledConfig({ enabled: false }),
    });
    expect(findings).toEqual([]);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('returns empty when no provider configured', async () => {
    const findings = await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/a.js'],
      toolConfig:    enabledConfig({ provider: undefined }),
    });
    expect(findings).toEqual([]);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('scans only up to fileCap files when all files are tier3 (no keywords)', async () => {
    const changedFiles = files('src/file', 30);
    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });
    // 30 tier3 files, fileCap 20, no secondary (tier2 overflow is empty)
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
  });

  it('secondary batch picks up keyword-matching overflow files', async () => {
    // 25 files contain a suspicious keyword → all tier2
    const keywordContent = 'require("child_process").execSync("ls")';
    mockReadFile.mockResolvedValue(keywordContent);

    const changedFiles = files('src/kw', 25);
    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 20 tier2 files (fills the cap)
    // secondary: 5 remaining tier2 files (overflow), capped at secondaryFileCap=20
    expect(mockCompleteSimple).toHaveBeenCalledTimes(25);
  });

  it('secondary batch is capped at secondaryFileCap', async () => {
    // 40 keyword-matching files
    mockReadFile.mockResolvedValue('require("child_process").execSync("ls")');
    const changedFiles = files('src/kw', 40);

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ fileCap: 20, secondaryFileCap: 10 }),
    });

    // primary: 20, secondary: min(20 overflow, cap=10) = 10 → total 30
    expect(mockCompleteSimple).toHaveBeenCalledTimes(30);
  });

  it('secondaryFileCap: 0 disables secondary batch entirely', async () => {
    mockReadFile.mockResolvedValue('require("child_process").execSync("ls")');
    const changedFiles = files('src/kw', 30);

    await runSpectre({
      workspacePath: WORKSPACE,
      changedFiles,
      toolConfig: enabledConfig({ secondaryFileCap: 0 }),
    });

    // Only primary 20 scanned, no secondary
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
  });

  it('tier3 overflow files are never included in the secondary batch', async () => {
    // Mix: 5 keyword files + 25 ordinary files
    mockReadFile.mockImplementation(async (path: string) => {
      const fname = String(path).split('/').pop() ?? '';
      return fname.startsWith('kw') ? 'execSync("ls")' : 'const x = 1;';
    });

    const changedFiles = [
      ...files('src/kw', 5),    // tier2
      ...files('src/plain', 25), // tier3
    ];

    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 5 tier2 + 15 tier3 = 20; secondary overflow tier2: 0 → total 20
    expect(mockCompleteSimple).toHaveBeenCalledTimes(20);
  });

  it('tier1 files (manifests) consume primary slots before tier2/tier3', async () => {
    // 5 package.json-style tier1 files + 20 keyword files
    mockReadFile.mockResolvedValue('execSync("ls")');

    const tier1Files  = Array.from({ length: 5 }, (_, i) => `pkg${i}/package.json`);
    const tier2Files  = files('src/kw', 20);
    const changedFiles = [...tier1Files, ...tier2Files];

    await runSpectre({ workspacePath: WORKSPACE, changedFiles, toolConfig: enabledConfig() });

    // primary: 5 tier1 + 15 tier2 = 20
    // secondary: remaining 5 tier2, capped at 20 → 5
    // total: 25
    expect(mockCompleteSimple).toHaveBeenCalledTimes(25);
  });
});
