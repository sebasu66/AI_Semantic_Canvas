import path from 'node:path';
import type { BrowserProvider } from './types.js';
import { LocalHarnessProvider } from './providers/local-harness.js';
import { CloudBrowserUseProvider } from './providers/cloud-browser-use.js';

export class BrowserProviderRegistry {
  private readonly providers = new Map<string, BrowserProvider>();

  register(provider: BrowserProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): BrowserProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown browser provider: ${id}`);
    return provider;
  }

  all(): BrowserProvider[] {
    return [...this.providers.values()];
  }

  async statuses() {
    return await Promise.all(this.all().map(provider => provider.status()));
  }
}

export function createBrowserRegistry(repoRoot: string): BrowserProviderRegistry {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const registry = new BrowserProviderRegistry();

  registry.register(new LocalHarnessProvider({
    id: 'chrome-personal',
    label: 'Chrome Personal',
    repoRoot,
    replPort: 9876,
    profileDir: path.join(localAppData, 'Google', 'Chrome', 'User Data'),
  }));

  registry.register(new LocalHarnessProvider({
    id: 'edge-worker',
    label: 'Edge Worker',
    repoRoot,
    replPort: 9877,
    profileDir: path.join(repoRoot, '.runtime', 'edge-worker-profile'),
    launch: {
      executableCandidates: [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
  }));

  registry.register(new CloudBrowserUseProvider({
    apiKey: process.env.BROWSER_USE_API_KEY,
    proxyCountryCode: process.env.BROWSER_USE_PROXY_COUNTRY || undefined,
  }));

  return registry;
}
