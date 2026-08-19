from pathlib import Path

p = Path('apps/bridge/src/index.ts')
s = p.read_text(encoding='utf-8-sig')

old_import = "import { chromium, BrowserContext, Page } from 'playwright';"
new_import = old_import + "\nimport type { BrowserProvider } from './browser/types.js';\nimport { createBrowserRegistry } from './browser/registry.js';"
if "createBrowserRegistry" not in s:
    s = s.replace(old_import, new_import, 1)

root_line = "const repoRoot = path.resolve(here, '../../..');"
if "const browserRegistry = createBrowserRegistry(repoRoot);" not in s:
    s = s.replace(root_line, root_line + "\nconst browserRegistry = createBrowserRegistry(repoRoot);", 1)

marker = "app.get('/api/health', (_req, res) => {"
if "app.get('/api/providers'" not in s:
    block = r'''
async function snapshotProviderTarget(provider: BrowserProvider, targetId: string): Promise<Snapshot> {
  const selectorLiteral = JSON.stringify(SEMANTIC_SELECTOR);
  const expression = `(() => {
    const selector = ${selectorLiteral};
    const candidates = Array.from(document.querySelectorAll(selector));
    const elements = candidates.slice(0, 700).map((el, sourceIndex) => {
      const node = el;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const text = String(node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 420);
      const role = node.getAttribute('role') || node.tagName.toLowerCase();
      const inputType = node instanceof HTMLInputElement ? node.type : null;
      const placeholder = node instanceof HTMLInputElement ? node.placeholder : node.getAttribute('placeholder');
      return {
        id: 'e' + sourceIndex,
        sourceIndex,
        tag: node.tagName.toLowerCase(),
        role,
        text,
        href: node instanceof HTMLAnchorElement ? node.href : null,
        inputType,
        placeholder,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
      };
    }).filter(element => element.visible && (element.text || ['input','select','textarea','button','a'].includes(element.tag)));
    return {
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      elements
    };
  })()`;
  return await provider.evaluate<Snapshot>(targetId, expression);
}

app.get('/api/providers', async (_req, res) => {
  try {
    res.json({ ok: true, providers: await browserRegistry.statuses() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/providers/:providerId/connect', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    await provider.ensureConnected();
    res.json({ ok: true, status: await provider.status(), targets: await provider.listTargets() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/providers/:providerId/targets', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    res.json({ ok: true, targets: await provider.listTargets() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/providers/:providerId/open', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const url = String(req.body?.url || 'https://example.com');
    const target = await provider.open(url);
    const snapshot = await snapshotProviderTarget(provider, target.targetId);
    const model = buildSemanticModel(snapshot);
    res.json({ ok: true, target, snapshot, ...model });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/providers/:providerId/snapshot', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const targetId = String(req.body?.targetId || '');
    if (!targetId) throw new Error('targetId is required');
    const snapshot = await snapshotProviderTarget(provider, targetId);
    const model = buildSemanticModel(snapshot);
    res.json({ ok: true, targetId, snapshot, ...model });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/providers/:providerId/action', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const targetId = String(req.body?.targetId || '');
    const action = req.body?.action as SemanticAction | undefined;
    if (!targetId) throw new Error('targetId is required');
    if (!action?.kind) throw new Error('action is required');

    if (action.kind === 'navigate') {
      if (!action.href) throw new Error('Navigate action requires href');
      await provider.navigate(targetId, action.href);
    } else {
      if (!Number.isInteger(action.sourceIndex)) throw new Error('Click action requires sourceIndex');
      const selector = JSON.stringify(SEMANTIC_SELECTOR);
      const index = Number(action.sourceIndex);
      await provider.evaluate(targetId, `(() => { const nodes=Array.from(document.querySelectorAll(${selector})); const node=nodes[${index}]; if(!node) throw new Error('Source element not found'); node.click(); return true; })()`);
      await new Promise(resolve => setTimeout(resolve, 650));
    }

    const snapshot = await snapshotProviderTarget(provider, targetId);
    const model = buildSemanticModel(snapshot);
    res.json({ ok: true, targetId, snapshot, ...model });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

'''
    if marker not in s:
        raise SystemExit('health marker not found')
    s = s.replace(marker, block + marker, 1)

p.write_text(s, encoding='utf-8')
print('provider API patched')
