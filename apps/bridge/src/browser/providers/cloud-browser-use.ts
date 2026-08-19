import type { BrowserProvider, BrowserProviderStatus, BrowserTarget } from '../types.js';
import { HarnessReplClient } from '../harness-repl.js';

type CloudBrowserSession = {
  id: string;
  status: 'active' | 'stopped';
  cdpUrl?: string | null;
  liveUrl?: string | null;
};

export type CloudBrowserUseProviderOptions = {
  repoRoot: string;
  replPort?: number;
  apiKey?: string;
  proxyCountryCode?: string | null;
};

export class CloudBrowserUseProvider implements BrowserProvider {
  readonly id = 'cloud-browser-use';
  readonly label = 'Browser Use Cloud';
  readonly kind = 'cloud-browser-use' as const;

  private readonly repl: HarnessReplClient;
  private readonly apiKey?: string;
  private readonly proxyCountryCode?: string | null;
  private session: CloudBrowserSession | null = null;

  constructor(options: CloudBrowserUseProviderOptions) {
    this.repl = new HarnessReplClient(options.repoRoot, options.replPort ?? 9880);
    this.apiKey = options.apiKey;
    this.proxyCountryCode = options.proxyCountryCode;
  }

  private async cloudRequest<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.apiKey) throw new Error('BROWSER_USE_API_KEY is not configured');
    const response = await fetch(`https://api.browser-use.com/api/v3${path}`, {
      ...init,
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : {}; } catch { /* keep raw text */ }
    if (!response.ok) throw new Error(`Browser Use API ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return data as T;
  }

  private async createCloudBrowser(): Promise<CloudBrowserSession> {
    const body: Record<string, unknown> = {
      timeout: 60,
      enableRecording: false,
    };
    if (this.proxyCountryCode !== undefined) body.proxyCountryCode = this.proxyCountryCode;
    const session = await this.cloudRequest<CloudBrowserSession>('/browsers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!session.cdpUrl) throw new Error('Browser Use Cloud created a browser without cdpUrl');
    this.session = session;
    return session;
  }

  async ensureConnected(): Promise<void> {
    if (!this.apiKey) throw new Error('BROWSER_USE_API_KEY is not configured');
    await this.repl.ensureRunning();
    const health = await this.repl.health();
    if (health?.connected && this.session?.status === 'active') return;

    if (!this.session || this.session.status !== 'active' || !this.session.cdpUrl) {
      await this.createCloudBrowser();
    }
    await this.repl.connectWs(this.session!.cdpUrl!, 30_000);
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
      configured: Boolean(this.apiKey),
      connected: Boolean(health?.connected && this.session?.status === 'active'),
      targetCount,
      detail: this.apiKey ? 'Cloud browser available on demand' : 'Set BROWSER_USE_API_KEY to enable',
      liveUrl: this.session?.liveUrl ?? null,
    };
  }

  private toTarget(target: { targetId: string; title: string; url: string }): BrowserTarget {
    return {
      providerId: this.id,
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      browserLabel: this.label,
      liveUrl: this.session?.liveUrl ?? null,
    };
  }

  async listTargets(): Promise<BrowserTarget[]> {
    await this.ensureConnected();
    return (await this.repl.listTargets()).map(target => this.toTarget(target));
  }

  async open(url: string): Promise<BrowserTarget> {
    await this.ensureConnected();
    const targetId = await this.repl.createTarget(url);
    await new Promise(resolve => setTimeout(resolve, 700));
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

  async closeTarget(targetId: string): Promise<void> {
    await this.ensureConnected();
    await this.repl.closeTarget(targetId);
  }

  async dispose(): Promise<void> {
    if (!this.session || !this.apiKey || this.session.status !== 'active') return;
    await this.cloudRequest(`/browsers/${this.session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    });
    this.session = { ...this.session, status: 'stopped' };
  }
}
