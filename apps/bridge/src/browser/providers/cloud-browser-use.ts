import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { BrowserProvider, BrowserProviderStatus, BrowserTarget } from '../types.js';

type CloudBrowserSession = {
  id: string;
  status: 'active' | 'stopped';
  cdpUrl?: string | null;
  liveUrl?: string | null;
};

export type CloudBrowserUseProviderOptions = {
  apiKey?: string;
  proxyCountryCode?: string | null;
};

export class CloudBrowserUseProvider implements BrowserProvider {
  readonly id = 'cloud-browser-use';
  readonly label = 'Browser Use Cloud';
  readonly kind = 'cloud-browser-use' as const;

  private readonly apiKey?: string;
  private readonly proxyCountryCode?: string | null;
  private session: CloudBrowserSession | null = null;
  private browser: Browser | null = null;
  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new WeakMap<Page, string>();

  constructor(options: CloudBrowserUseProviderOptions) {
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
    if (this.browser?.isConnected() && this.session?.status === 'active') return;

    if (!this.session || this.session.status !== 'active' || !this.session.cdpUrl) {
      await this.createCloudBrowser();
    }

    this.browser = await chromium.connectOverCDP(this.session!.cdpUrl!);
    this.reindexPages();
  }

  private reindexPages(): void {
    if (!this.browser) return;
    for (const context of this.browser.contexts()) {
      for (const page of context.pages()) this.idForPage(page);
    }
  }

  private idForPage(page: Page): string {
    let id = this.pageIds.get(page);
    if (!id) {
      id = randomUUID();
      this.pageIds.set(page, id);
      this.pages.set(id, page);
      page.once('close', () => this.pages.delete(id!));
    }
    return id;
  }

  private async targetForPage(page: Page): Promise<BrowserTarget> {
    const targetId = this.idForPage(page);
    let title = page.url();
    try { title = await page.title(); } catch { /* page may be navigating */ }
    return {
      providerId: this.id,
      targetId,
      title,
      url: page.url(),
      browserLabel: this.label,
      liveUrl: this.session?.liveUrl ?? null,
    };
  }

  private getPage(targetId: string): Page {
    const page = this.pages.get(targetId);
    if (!page || page.isClosed()) throw new Error(`Cloud target not found: ${targetId}`);
    return page;
  }

  async status(): Promise<BrowserProviderStatus> {
    const connected = Boolean(this.browser?.isConnected() && this.session?.status === 'active');
    if (connected) this.reindexPages();
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      configured: Boolean(this.apiKey),
      connected,
      targetCount: connected ? this.pages.size : 0,
      detail: this.apiKey ? 'Cloud browser available on demand' : 'Set BROWSER_USE_API_KEY to enable',
      liveUrl: this.session?.liveUrl ?? null,
    };
  }

  async listTargets(): Promise<BrowserTarget[]> {
    await this.ensureConnected();
    this.reindexPages();
    return await Promise.all([...this.pages.values()].filter(page => !page.isClosed()).map(page => this.targetForPage(page)));
  }

  async open(url: string): Promise<BrowserTarget> {
    await this.ensureConnected();
    const context = this.browser!.contexts()[0] ?? await this.browser!.newContext();
    const page = await context.newPage();
    this.idForPage(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return await this.targetForPage(page);
  }

  async navigate(targetId: string, url: string): Promise<BrowserTarget> {
    await this.ensureConnected();
    const page = this.getPage(targetId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return await this.targetForPage(page);
  }

  async evaluate<T = unknown>(targetId: string, expression: string): Promise<T> {
    await this.ensureConnected();
    return await this.getPage(targetId).evaluate(expression as never) as T;
  }

  async closeTarget(targetId: string): Promise<void> {
    const page = this.getPage(targetId);
    await page.close();
    this.pages.delete(targetId);
  }

  async dispose(): Promise<void> {
    try { await this.browser?.close(); } catch { /* best effort */ }
    this.browser = null;
    this.pages.clear();

    if (!this.session || !this.apiKey || this.session.status !== 'active') return;
    await this.cloudRequest(`/browsers/${this.session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'stop' }),
    });
    this.session = { ...this.session, status: 'stopped' };
  }
}
