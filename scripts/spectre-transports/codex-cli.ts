import { spawn, type ChildProcess } from 'child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  SpectreTransportError,
  spectreTransportCancelled,
  type JsonValue,
  type SpectreTransport,
  type SpectreTransportRequest,
  type SpectreTransportResponse,
} from '../../src/spectre-transport.js';

export interface CodexCommandOptions {
  schemaPath: string;
  outputPath: string;
  model?: string;
}

/** Build a shell-free Codex invocation. The prompt is intentionally read from stdin. */
export function buildCodexArgs({ schemaPath, outputPath, model }: CodexCommandOptions): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--output-schema', schemaPath,
    '--skip-git-repo-check',
    '--color', 'never',
    '--output-last-message', outputPath,
  ];
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

type SpawnCodex = (command: string, args: readonly string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcess;

type SignalProcessGroup = (pid: number, signal: NodeJS.Signals) => void;

export interface CodexCliTransportOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  spawnProcess?: SpawnCodex;
  signalProcessGroup?: SignalProcessGroup;
}

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const PASSTHROUGH_ENV = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'VOLTA_HOME',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

function isolatedEnvironment({ home, temp, config, codexHome }: {
  home: string;
  temp: string;
  config: string;
  codexHome: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: temp,
    XDG_DATA_HOME: config,
    XDG_STATE_HOME: config,
    APPDATA: config,
    LOCALAPPDATA: config,
    CODEX_HOME: codexHome,
    // Volta shims use VOLTA_HOME after HOME has been isolated.
    VOLTA_HOME: env.VOLTA_HOME ?? join(homedir(), '.volta'),
  };
}

/**
 * Codex strict structured outputs require every declared property to be
 * required. Project optional properties out rather than changing Spectre's
 * canonical schema or forcing models to invent optional values.
 */
export function buildCodexResponseSchema(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) return schema.map(buildCodexResponseSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const source = schema as { readonly [key: string]: JsonValue };
  const projected: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(source)) {
    projected[key] = buildCodexResponseSchema(value);
  }

  const properties = source['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(
      Array.isArray(source['required'])
        ? source['required'].filter((value): value is string => typeof value === 'string')
        : [],
    );
    const requiredProperties = Object.fromEntries(
      Object.entries(properties)
        .filter(([name]) => required.has(name))
        .map(([name, value]) => [name, buildCodexResponseSchema(value)]),
    );
    projected['properties'] = requiredProperties;
    projected['required'] = Object.keys(requiredProperties);
  }

  return projected;
}

async function copyCodexAuthentication(targetCodexHome: string): Promise<void> {
  const sourceCodexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  try {
    const authentication = await readFile(join(sourceCodexHome, 'auth.json'));
    await writeFile(join(targetCodexHome, 'auth.json'), authentication, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function collect(stream: NodeJS.ReadableStream | null): { value: () => string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream?.on('data', (chunk: Buffer | string) => {
    if (bytes >= MAX_DIAGNOSTIC_BYTES) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const admitted = buffer.subarray(0, MAX_DIAGNOSTIC_BYTES - bytes);
    chunks.push(admitted);
    bytes += admitted.length;
  });
  return { value: () => Buffer.concat(chunks).toString('utf8').trim() };
}

function diagnosticTail(value: string): string {
  const buffer = Buffer.from(value);
  return buffer.subarray(Math.max(0, buffer.length - 8_192)).toString('utf8').trim();
}

function runCodex(
  child: ChildProcess,
  prompt: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  terminationGraceMs: number,
  signalProcessGroup: SignalProcessGroup,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    let settled = false;
    let terminationError: SpectreTransportError | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      signal?.removeEventListener('abort', cancel);
      fn();
    };
    const signalProcess = (processSignal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          signalProcessGroup(child.pid, processSignal);
          return;
        } catch {
          // Fall back to the direct child when process-group signalling fails.
        }
      }
      child.kill(processSignal);
    };
    const terminate = (error: SpectreTransportError) => {
      if (terminationError) return;
      terminationError = error;
      signalProcess('SIGTERM');
      escalationTimer = setTimeout(() => signalProcess('SIGKILL'), terminationGraceMs);
    };
    const cancel = () => terminate(spectreTransportCancelled(signal?.reason));
    const timer = setTimeout(() => {
      terminate(new SpectreTransportError(
        'timeout',
        `Codex CLI exceeded ${timeoutMs}ms`,
        { retryable: true },
      ));
    }, timeoutMs);

    child.once('error', error => finish(() => reject(new SpectreTransportError(
      'unavailable',
      `Unable to start Codex CLI: ${error.message}`,
      { cause: error, retryable: true },
    ))));
    child.once('close', (code, closeSignal) => finish(() => {
      if (terminationError) {
        reject(terminationError);
      } else if (code !== 0) {
        const detail = diagnosticTail(stderr.value() || stdout.value());
        reject(new SpectreTransportError(
          'failed',
          `Codex CLI exited with ${closeSignal ? `signal ${closeSignal}` : `code ${String(code)}`}${detail ? `: ${detail}` : ''}`,
        ));
      } else {
        resolve({ stdout: stdout.value(), stderr: stderr.value() });
      }
    }));

    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }

    if (!child.stdin) {
      signalProcess('SIGTERM');
      finish(() => reject(new SpectreTransportError('unavailable', 'Codex CLI stdin is unavailable')));
      return;
    }
    child.stdin.once('error', error => terminate(new SpectreTransportError(
      'failed',
      `Could not send prompt to Codex CLI: ${error.message}`,
      { cause: error },
    )));
    child.stdin.end(prompt, 'utf8');
  });
}

export class CodexCliSpectreTransport implements SpectreTransport {
  private readonly command: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly spawnProcess: SpawnCodex;
  private readonly signalProcessGroup: SignalProcessGroup;

  constructor(options: CodexCliTransportOptions = {}) {
    this.command = options.command ?? 'codex';
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.signalProcessGroup = options.signalProcessGroup ?? ((pid, signal) => { process.kill(-pid, signal); });
  }

  async complete(request: SpectreTransportRequest): Promise<SpectreTransportResponse> {
    if (request.signal?.aborted) throw spectreTransportCancelled(request.signal.reason);

    const root = await mkdtemp(join(tmpdir(), 'layne-spectre-codex-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const config = join(root, 'config');
    const codexHome = join(root, 'codex');
    const schemaPath = join(cwd, 'response-schema.json');
    const outputPath = join(cwd, 'response.json');
    try {
      try {
        await Promise.all([
          mkdir(cwd, { mode: 0o700 }),
          mkdir(home, { mode: 0o700 }),
          mkdir(temp, { mode: 0o700 }),
          mkdir(config, { mode: 0o700 }),
          mkdir(codexHome, { mode: 0o700 }),
        ]);
        await copyCodexAuthentication(codexHome);
        await writeFile(schemaPath, JSON.stringify(buildCodexResponseSchema(request.responseSchema)), {
          encoding: 'utf8',
          mode: 0o600,
        });
        if (request.signal?.aborted) throw spectreTransportCancelled(request.signal.reason);

        let child: ChildProcess;
        try {
          child = this.spawnProcess(
            this.command,
            buildCodexArgs({ schemaPath, outputPath, model: this.model }),
            {
              cwd,
              env: isolatedEnvironment({ home, temp, config, codexHome }),
              detached: process.platform !== 'win32',
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
        } catch (error) {
          throw new SpectreTransportError('unavailable', 'Unable to start Codex CLI', {
            cause: error,
            retryable: true,
          });
        }
        await runCodex(
          child,
          request.prompt,
          request.signal,
          this.timeoutMs,
          this.terminationGraceMs,
          this.signalProcessGroup,
        );

        let text: string;
        try {
          text = (await readFile(outputPath, 'utf8')).trim();
        } catch (error) {
          throw new SpectreTransportError('invalid-response', 'Codex CLI did not write its final response', { cause: error });
        }
        if (!text) throw new SpectreTransportError('invalid-response', 'Codex CLI returned an empty response');
        return { text };
      } catch (error) {
        if (error instanceof SpectreTransportError) throw error;
        throw new SpectreTransportError('failed', 'Codex CLI transport failed', { cause: error });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export function createCodexCliSpectreTransport(options: CodexCliTransportOptions = {}): CodexCliSpectreTransport {
  return new CodexCliSpectreTransport(options);
}
