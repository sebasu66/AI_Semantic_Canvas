import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = path.join(root, 'apps/bridge/src/index.ts');
let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(anchor, replacement) {
  if (!src.includes(anchor)) throw new Error(`Missing anchor:\n${anchor.slice(0, 180)}`);
  src = src.replace(anchor, replacement);
}

replaceOnce(
`type SemanticModel = {
  sourceKind: 'web' | 'gmail' | 'gdrive' | 'google-search';
  semanticObjects: SemanticObject[];
};`,
`type SemanticModel = {
  sourceKind: 'web' | 'gmail' | 'gdrive' | 'google-search';
  semanticObjects: SemanticObject[];
};

type StructuralDiagnostics = {
  title: string;
  url: string;
  readyState?: string;
  bodyTextLength?: number;
  semanticElementCount: number;
  roleCounts: Record<string, number>;
  tagCounts: Record<string, number>;
  rowLikeCount: number;
  gmailCandidateCount: number;
  actionElementCount: number;
  rowSamples: Array<{ tag: string; role: string; textLength: number; bbox: number[]; hasHref: boolean }>;
  domSelectors?: Record<string, { total: number; visible: number }>;
};

function snapshotDiagnostics(snapshot: Snapshot): StructuralDiagnostics {
  const roleCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  for (const element of snapshot.elements) {
    roleCounts[element.role] = (roleCounts[element.role] || 0) + 1;
    tagCounts[element.tag] = (tagCounts[element.tag] || 0) + 1;
  }
  const rowLike = snapshot.elements.filter(element => element.tag === 'tr' || element.role === 'row');
  const gmailCandidates = rowLike.filter(element => {
    const [, , width = 0, height = 0] = element.bbox;
    return element.text.length >= 8 && element.text.length <= 620 && width >= 280 && height >= 18 && height <= 140;
  });
  return {
    title: snapshot.title,
    url: snapshot.url,
    semanticElementCount: snapshot.elements.length,
    roleCounts,
    tagCounts,
    rowLikeCount: rowLike.length,
    gmailCandidateCount: gmailCandidates.length,
    actionElementCount: snapshot.elements.filter(element => Boolean(element.href) || element.tag === 'button' || element.role === 'button').length,
    rowSamples: rowLike.slice(0, 10).map(element => ({
      tag: element.tag,
      role: element.role,
      textLength: element.text.length,
      bbox: element.bbox,
      hasHref: Boolean(element.href),
    })),
  };
}

function modelDiagnostics(model: SemanticModel) {
  return {
    sourceKind: model.sourceKind,
    objectCount: model.semanticObjects.length,
    objects: model.semanticObjects.map(object => ({
      id: object.id,
      type: object.type,
      itemCount: object.items?.length || 0,
      actionCount: object.actions.length,
      representation: object.representation || 'data',
    })),
  };
}

function logSemanticDebug(stage: string, payload: unknown) {
  console.log('[semantic-debug]', JSON.stringify({ ts: new Date().toISOString(), stage, payload }));
}

async function providerDomDiagnostics(provider: BrowserProvider, targetId: string) {
  return await provider.evaluate<any>(targetId, `(() => {
    const visible = (el) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
    const selectors = {
      all: '*',
      tr: 'tr',
      gmailLegacy: 'tr[data-legacy-thread-id]',
      gmailZA: 'tr.zA',
      roleRow: '[role="row"]',
      roleMain: '[role="main"]',
      roleGrid: '[role="grid"]',
      roleTable: '[role="table"]',
      links: 'a',
      buttons: 'button,[role="button"]',
      iframes: 'iframe',
    };
    const domSelectors = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const nodes = Array.from(document.querySelectorAll(selector));
      domSelectors[name] = { total: nodes.length, visible: nodes.filter(visible).length };
    }
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      bodyTextLength: String(document.body?.innerText || '').length,
      domSelectors,
    };
  })()`);
}`
);

replaceOnce(
`async function waitForSemanticContent(provider: BrowserProvider, targetId: string, urlValue: string): Promise<void> {
  const kind = sourceKindForUrl(urlValue);
  if (kind !== 'gmail' && kind !== 'gdrive') return;
  const selector = kind === 'gmail'
    ? 'tr[data-legacy-thread-id], tr.zA, [role="row"]'
    : '[role="gridcell"], [role="row"], [role="listitem"]';
  const encodedSelector = JSON.stringify(selector);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const count = await provider.evaluate<number>(targetId, \`(() => Array.from(document.querySelectorAll(\${encodedSelector})).filter(el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; }).length)()\`);
      if (Number(count) >= 3) return;
    } catch {
      // SPA readiness is best-effort; semantic snapshot still has a generic fallback.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}`,
`async function waitForSemanticContent(provider: BrowserProvider, targetId: string, urlValue: string): Promise<void> {
  const kind = sourceKindForUrl(urlValue);
  if (kind !== 'gmail' && kind !== 'gdrive') return;
  const selector = kind === 'gmail'
    ? 'tr[data-legacy-thread-id], tr.zA, [role="row"]'
    : '[role="gridcell"], [role="row"], [role="listitem"]';
  const encodedSelector = JSON.stringify(selector);
  let lastCount = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const count = await provider.evaluate<number>(targetId, \`(() => Array.from(document.querySelectorAll(\${encodedSelector})).filter(el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; }).length)()\`);
      lastCount = Number(count) || 0;
      if (attempt === 0 || attempt % 5 === 4 || lastCount >= 3) {
        logSemanticDebug('readiness', { providerId: provider.id, targetId, kind, attempt: attempt + 1, selector, visibleCount: lastCount });
      }
      if (lastCount >= 3) return;
    } catch (error) {
      logSemanticDebug('readiness-error', { providerId: provider.id, targetId, kind, attempt: attempt + 1, error: String(error) });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  logSemanticDebug('readiness-timeout', { providerId: provider.id, targetId, kind, selector, visibleCount: lastCount });
}`
);

replaceOnce(
`  return await provider.evaluate<Snapshot>(targetId, expression);
}


type RecipeState`,
`  const snapshot = await provider.evaluate<Snapshot>(targetId, expression);
  logSemanticDebug('snapshot', { providerId: provider.id, targetId, ...snapshotDiagnostics(snapshot) });
  return snapshot;
}


type RecipeState`
);

replaceOnce(
`app.get('/api/providers', async (_req, res) => {`,
`app.post('/api/providers/:providerId/debug-semantic', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const targetId = String(req.body?.targetId || '');
    if (!targetId) throw new Error('targetId is required');
    const dom = await providerDomDiagnostics(provider, targetId);
    const snapshot = await snapshotProviderTarget(provider, targetId);
    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);
    const diagnostics = { ...snapshotDiagnostics(snapshot), ...dom, model: modelDiagnostics(model), recipe: model.recipe };
    logSemanticDebug('debug-endpoint', { providerId: provider.id, targetId, diagnostics });
    res.json({ ok: true, targetId, diagnostics });
  } catch (error) {
    logSemanticDebug('debug-endpoint-error', { providerId: String(req.params.providerId), error: String(error) });
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/providers', async (_req, res) => {`
);

for (const marker of [
  `    const model = await semanticModelForProviderTarget(provider, target.targetId, snapshot);\n    res.json({ ok: true, target, snapshot, ...model });`,
  `    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);\n    res.json({ ok: true, targetId, snapshot, ...model });`,
]) {
  if (!src.includes(marker)) throw new Error(`Missing route marker: ${marker}`);
}

replaceOnce(
`    const model = await semanticModelForProviderTarget(provider, target.targetId, snapshot);
    res.json({ ok: true, target, snapshot, ...model });`,
`    const model = await semanticModelForProviderTarget(provider, target.targetId, snapshot);
    logSemanticDebug('provider-open', { providerId: provider.id, targetId: target.targetId, snapshot: snapshotDiagnostics(snapshot), model: modelDiagnostics(model), recipe: model.recipe });
    res.json({ ok: true, target, snapshot, ...model });`
);

replaceOnce(
`    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);
    res.json({ ok: true, targetId, snapshot, ...model });`,
`    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);
    logSemanticDebug('provider-snapshot', { providerId: provider.id, targetId, snapshot: snapshotDiagnostics(snapshot), model: modelDiagnostics(model), recipe: model.recipe });
    res.json({ ok: true, targetId, snapshot, ...model });`
);

fs.writeFileSync(file, src, 'utf8');
console.log('semantic debug logging installed');
