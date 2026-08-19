import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type HarnessHealth = {
  ok: boolean;
  connected?: boolean;
  sessionId?: string | null;
  uptime?: number;
};

export type HarnessTarget = {
  targetId: string;
  title: string;
  url: string;
  type: string;
};

function parseHarnessResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export class HarnessReplClient {
  constructor(
    readonly repoRoot: string,
    readonly port: number,
  ) {}

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async health(): Promise<HarnessHealth | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) return null;
      return await response.json() as HarnessHealth;
    } catch {
      return null;
    }
  }

  async ensureRunning(): Promise<void> {
    if ((await this.health())?.ok) return;

    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const bunPath = process.platform === 'win32'
      ? path.join(home, '.bun', 'bin', 'bun.exe')
      : path.join(home, '.bun', 'bin', 'bun');
    const replPath = path.join(this.repoRoot, '.tools', 'browser-harness-js', 'sdk', 'repl.ts');
    if (!existsSync(bunPath)) throw new Error(`Bun not found at ${bunPath}. Run scripts/setup-browser-harness.ps1 first.`);
    if (!existsSync(replPath)) throw new Error(`Browser Harness JS not found at ${replPath}. Run scripts/setup-browser-harness.ps1 first.`);

    const runtimeDir = path.join(this.repoRoot, '.runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const stdoutPath = path.join(runtimeDir, `browser-harness-${this.port}.log`);
    const stderrPath = path.join(runtimeDir, `browser-harness-${this.port}.err.log`);
    const outFd = openSync(stdoutPath, 'a');
    const errFd = openSync(stderrPath, 'a');

    try {
      const child = spawn(bunPath, [replPath], {
        cwd: path.dirname(replPath),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        env: { ...process.env, CDP_REPL_PORT: String(this.port) },
      });
      child.unref();
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }

    for (let i = 0; i < 50; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if ((await this.health())?.ok) return;
    }
    throw new Error(`Browser Harness REPL did not start on port ${this.port}`);
  }

  async eval<T = unknown>(code: string, timeoutMs = 45_000): Promise<T> {
    await this.ensureRunning();
    const response = await fetch(`${this.baseUrl}/eval`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: code,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body.trim() || `Browser Harness REPL HTTP ${response.status}`);
    return parseHarnessResponse(body) as T;
  }

  async connectProfile(profileDir: string, timeoutMs = 30_000): Promise<void> {
    const profile = JSON.stringify(profileDir);
    await this.eval(`await session.connect({profileDir:${profile},timeoutMs:${timeoutMs}})`, timeoutMs + 5_000);
  }

  async connectWs(wsUrl: string, timeoutMs = 30_000): Promise<void> {
    const url = JSON.stringify(wsUrl);
    await this.eval(`await session.connect({wsUrl:${url},timeoutMs:${timeoutMs}})`, timeoutMs + 5_000);
  }

  async listTargets(): Promise<HarnessTarget[]> {
    return await this.eval<HarnessTarget[]>('await listPageTargets()') ?? [];
  }

  async createTarget(url: string): Promise<string> {
    const escaped = JSON.stringify(url);
    const result = await this.eval<{ targetId: string }>(`await session.Target.createTarget({url:${escaped}})`);
    if (!result?.targetId) throw new Error('Browser Harness did not return a targetId');
    return result.targetId;
  }

  async navigate(targetId: string, url: string): Promise<void> {
    const tid = JSON.stringify(targetId);
    const href = JSON.stringify(url);
    await this.eval(`
await session.use(${tid});
await session.Page.enable();
await session.Page.navigate({url:${href}});
for (let i=0;i<40;i++) {
  const r=await session.Runtime.evaluate({expression:'document.readyState',returnByValue:true});
  if (r?.result?.value === 'interactive' || r?.result?.value === 'complete') break;
  await Bun.sleep(250);
}
return true;
`);
  }

  async evaluate<T = unknown>(targetId: string, expression: string): Promise<T> {
    const tid = JSON.stringify(targetId);
    const expr = JSON.stringify(expression);
    return await this.eval<T>(`
await session.use(${tid});
const r=await session.Runtime.evaluate({expression:${expr},returnByValue:true,awaitPromise:true,userGesture:true});
if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'Runtime.evaluate failed');
return r.result?.value;
`);
  }

  async closeTarget(targetId: string): Promise<void> {
    const tid = JSON.stringify(targetId);
    await this.eval(`await session.Target.closeTarget({targetId:${tid}})`);
  }
}
