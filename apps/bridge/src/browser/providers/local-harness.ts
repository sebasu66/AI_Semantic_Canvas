import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserProvider, BrowserProviderStatus, BrowserTarget } from '../types.js';
import { HarnessReplClient } from '../harness-repl.js';

type LaunchConfig = {
  executableCandidates: string[];
  args?: string[];
};

export type LocalHarnessProviderOptions = {
  id: string;
  label: string;
  repoRoot: string;
  replPort: number;
  profileDir: string;
  launch?: LaunchConfig;
};

export class LocalHarnessProvider implements BrowserProvider {
  readonly kind = 'local-harness' as const;
  readonly id: string;
  readonly label: string;

  private readonly profileDir: string;
  private readonly launchConfig?: LaunchConfig;
  private readonly repl: HarnessReplClient;
  private launchAttempted = false;

  constructor(options: LocalHarnessProviderOptions) {
    this.id = options.id;
    this.label = options.label;
    this.profileDir = options.profileDir;
    this.launchConfig = options.launch;
    this.repl = new HarnessReplClient(options.repoRoot, options.replPort);
  }

  private async ensureBrowserRunning(): Promise<void> {
    if (!this.launchConfig || this.launchAttempted) return;
    this.launchAttempted = true;

    const executable = this.launchConfig.executableCandidates.find(candidate => existsSync(candidate));
    if (!executable) {
      throw new Error(`${this.label} executable was not found. Checked: ${this.launchConfig.executableCandidates.join(', ')}`);
    }

    const args = [
      `--user-data-dir=${this.profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...(this.launchConfig.args ?? []),
      'about:blank',
    ];
    const child = spawn(executable, args, {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();

    const dap = path.join(this.profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 80; i += 1) {
      if (existsSync(dap)) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${this.label} started but DevToolsActivePort was not created in ${this.profileDir}`);
  }

  async ensureConnected(): Promise<void> {
    await this.repl.ensureRunning();
    const health = await this.repl.health();
    if (health?.connected) return;
    if (this.launchConfig) await this.ensureBrowserRunning();
    await this.repl.connectProfile(this.profileDir, 30_000);
  }

  async status(): Promise<BrowserProviderStatus> {
    const health = await this.repl.health();
    let targetCount = 0;
    if (health?.connected) {
      try { targetCount = (await this.repl.listTargets()).length; } catch { /* best effort */ }
    }
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      configured: existsSync(this.profileDir) || Boolean(this.launchConfig),
      connected: Boolean(health?.connected),
      targetCount,
      detail: health?.connected ? 'Browser Harness connected' : 'Browser Harness ready; browser attach pending',
    };
  }

  private toTarget(target: { targetId: string; title: string; url: string }): BrowserTarget {
    return {
      providerId: this.id,
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      browserLabel: this.label,
    };
  }

  async listTargets(): Promise<BrowserTarget[]> {
    await this.ensureConnected();
    return (await this.repl.listTargets()).map(target => this.toTarget(target));
  }

  async open(url: string): Promise<BrowserTarget> {
    await this.ensureConnected();
    // Create a background target first so adding a source never steals focus from the canvas.
    const targetId = await this.repl.createTarget('about:blank', true);
    await this.repl.navigate(targetId, url);
    const target = (await this.repl.listTargets()).find(item => item.targetId === targetId);
    return this.toTarget(target ?? { targetId, title: url, url });
  }

  async navigate(targetId: string, url: string): Promise<BrowserTarget> {
    await this.ensureConnected();
    await this.repl.navigate(targetId, url);
    const target = (await this.repl.listTargets()).find(item => item.targetId === targetId);
    return this.toTarget(target ?? { targetId, title: url, url });
  }

  async evaluate<T = unknown>(targetId: string, expression: string): Promise<T> {
    await this.ensureConnected();
    return await this.repl.evaluate<T>(targetId, expression);
  }

  async captureRegion(targetId: string, selector: string): Promise<string | null> {
    await this.ensureConnected();
    return await this.repl.captureRegion(targetId, selector);
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.ensureConnected();
    await this.repl.closeTarget(targetId);
  }
}
