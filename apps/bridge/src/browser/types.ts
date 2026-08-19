export type BrowserProviderKind = 'local-harness' | 'cloud-browser-use' | 'playwright-local';

export type BrowserTarget = {
  providerId: string;
  targetId: string;
  title: string;
  url: string;
  browserLabel: string;
  liveUrl?: string | null;
};

export type BrowserProviderStatus = {
  id: string;
  label: string;
  kind: BrowserProviderKind;
  configured: boolean;
  connected: boolean;
  targetCount: number;
  detail?: string;
  liveUrl?: string | null;
};

export interface BrowserProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: BrowserProviderKind;

  status(): Promise<BrowserProviderStatus>;
  ensureConnected(): Promise<void>;
  listTargets(): Promise<BrowserTarget[]>;
  open(url: string): Promise<BrowserTarget>;
  navigate(targetId: string, url: string): Promise<BrowserTarget>;
  evaluate<T = unknown>(targetId: string, expression: string): Promise<T>;
  closeTarget?(targetId: string): Promise<void>;
  dispose?(): Promise<void>;
}
