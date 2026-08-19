import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, BrowserContext, Page } from 'playwright';
import type { BrowserProvider } from './browser/types.js';
import { createBrowserRegistry } from './browser/registry.js';
import { SiteRecipeStore, executeSiteRecipe, buildDiscoverySnapshot, type SiteRecipe } from './semantic/site-recipes.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const browserRegistry = createBrowserRegistry(repoRoot);
const siteRecipeStore = new SiteRecipeStore(repoRoot);
const profileDir = path.join(repoRoot, '.runtime', 'chrome-profile');
const SEMANTIC_SELECTOR = 'a,button,input,select,textarea,[role],[contenteditable="true"],h1,h2,h3,p,article,main,section,tr,td';

let context: BrowserContext | null = null;
let selectedPageIndex = 0;

type RawElement = {
  id: string;
  sourceIndex: number;
  tag: string;
  role: string;
  text: string;
  href: string | null;
  inputType: string | null;
  placeholder: string | null;
  visible: boolean;
  bbox: number[];
};

type Snapshot = {
  title: string;
  url: string;
  viewport: { width: number; height: number };
  elements: RawElement[];
};

type SemanticAction = {
  id: string;
  kind: 'navigate' | 'click';
  label: string;
  href?: string;
  sourceElementId?: string;
  sourceIndex?: number;
  selector?: string;
  itemIndex?: number;
};

type SemanticObjectType =
  | 'document'
  | 'section'
  | 'navigation'
  | 'form'
  | 'action'
  | 'mail-list'
  | 'drive-grid'
  | 'search-results';

type SemanticObject = {
  id: string;
  type: SemanticObjectType;
  label: string;
  title?: string;
  description?: string;
  text?: string;
  items?: string[];
  actions: SemanticAction[];
  provenance: {
    url: string;
    pageTitle: string;
    elementIds: string[];
    boxes: number[][];
  };
};

type SemanticModel = {
  sourceKind: 'web' | 'gmail' | 'gdrive' | 'google-search';
  semanticObjects: SemanticObject[];
};

function pages(): Page[] {
  return context?.pages() ?? [];
}

function pageAt(index?: number): Page {
  const all = pages();
  if (!all.length) throw new Error('No browser page is available. Launch Chrome first.');
  const i = Number.isInteger(index) ? Number(index) : selectedPageIndex;
  if (i < 0 || i >= all.length) throw new Error(`Invalid page index ${i}`);
  selectedPageIndex = i;
  return all[i];
}

function reusableBlankPage(): Page | null {
  const all = pages();
  if (all.length !== 1) return null;
  const page = all[0];
  return page.url() === 'about:blank' ? page : null;
}

function uniqueElements(elements: RawElement[]): RawElement[] {
  const seen = new Set<string>();
  const result: RawElement[] = [];
  for (const element of elements) {
    const normalized = element.text.replace(/\s+/g, ' ').trim().toLowerCase();
    const key = `${normalized}|${element.href ?? ''}`;
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(element);
  }
  return result;
}

function actionFromElement(element: RawElement, label?: string): SemanticAction | null {
  const actionLabel = (label || element.text).trim().slice(0, 110);
  if (!actionLabel) return null;
  if (element.href) {
    return {
      id: `navigate-${element.id}`,
      kind: 'navigate',
      label: actionLabel,
      href: element.href,
      sourceElementId: element.id,
      sourceIndex: element.sourceIndex
    };
  }
  if (element.tag === 'button' || element.role === 'button' || element.tag === 'tr' || element.role === 'row' || element.role === 'gridcell') {
    return {
      id: `click-${element.id}`,
      kind: 'click',
      label: actionLabel,
      sourceElementId: element.id,
      sourceIndex: element.sourceIndex
    };
  }
  return null;
}

function provenance(snapshot: Snapshot, elements: RawElement[]) {
  return {
    url: snapshot.url,
    pageTitle: snapshot.title,
    elementIds: elements.map(element => element.id),
    boxes: elements.map(element => element.bbox)
  };
}

function sourceKindForUrl(urlValue: string): SemanticModel['sourceKind'] {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    if (host === 'mail.google.com') return 'gmail';
    if (host === 'drive.google.com') return 'gdrive';
    if ((host === 'google.com' || host.endsWith('.google.com')) && url.pathname === '/search') return 'google-search';
  } catch {
    // fall through to generic web semantics
  }
  return 'web';
}

function buildGmailObjects(snapshot: Snapshot): SemanticObject[] {
  const rowCandidates = uniqueElements(snapshot.elements.filter(element =>
    (element.tag === 'tr' || element.role === 'row') &&
    element.text.length >= 8 &&
    element.text.length <= 360
  )).slice(0, 12);

  if (!rowCandidates.length) return [];
  const actions = rowCandidates
    .map(element => actionFromElement(element, element.text.slice(0, 72)))
    .filter((action): action is SemanticAction => Boolean(action));

  return [{
    id: 'gmail-inbox-visible',
    type: 'mail-list',
    label: 'Gmail',
    title: snapshot.title || 'Inbox',
    description: `${rowCandidates.length} visible conversations`,
    items: rowCandidates.map(element => element.text.slice(0, 150)),
    actions,
    provenance: provenance(snapshot, rowCandidates)
  }];
}

function buildDriveObjects(snapshot: Snapshot): SemanticObject[] {
  const candidates = uniqueElements(snapshot.elements.filter(element =>
    ['gridcell', 'row', 'listitem'].includes(element.role) &&
    element.text.length >= 2 &&
    element.text.length <= 260
  )).slice(0, 16);

  if (!candidates.length) return [];
  const actions = candidates
    .map(element => actionFromElement(element, element.text.slice(0, 72)))
    .filter((action): action is SemanticAction => Boolean(action));

  return [{
    id: 'gdrive-visible-items',
    type: 'drive-grid',
    label: 'Google Drive',
    title: 'Visible files',
    description: `${candidates.length} visible Drive items`,
    items: candidates.map(element => element.text.slice(0, 140)),
    actions,
    provenance: provenance(snapshot, candidates)
  }];
}

function buildGoogleSearchObjects(snapshot: Snapshot): SemanticObject[] {
  const links = uniqueElements(snapshot.elements.filter(element => {
    if (element.tag !== 'a' || !element.href || element.text.length < 3) return false;
    try {
      const href = new URL(element.href);
      return !href.hostname.endsWith('google.com') || (!href.pathname.startsWith('/search') && href.pathname !== '/');
    } catch {
      return false;
    }
  })).slice(0, 10);

  if (!links.length) return [];
  const actions = links
    .map(element => actionFromElement(element, element.text.slice(0, 90)))
    .filter((action): action is SemanticAction => Boolean(action));

  return [{
    id: 'google-search-results',
    type: 'search-results',
    label: 'Google Search',
    title: snapshot.title.replace(/ - Google Search$/i, '') || 'Search results',
    description: `${links.length} extracted results`,
    items: links.map(element => element.text.slice(0, 150)),
    actions,
    provenance: provenance(snapshot, links)
  }];
}

function buildGenericObjects(snapshot: Snapshot): SemanticObject[] {
  const elements = snapshot.elements;
  const headings = elements.filter(element => /^h[1-3]$/.test(element.tag));
  const paragraphs = elements.filter(element => element.tag === 'p' && element.text.length > 12);
  const links = uniqueElements(elements.filter(element => element.tag === 'a' && Boolean(element.href)));
  const buttons = uniqueElements(elements.filter(element => element.tag === 'button' || element.role === 'button'));
  const controls = elements.filter(element => ['input', 'select', 'textarea'].includes(element.tag));
  const objects: SemanticObject[] = [];
  const consumed = new Set<string>();

  const primaryHeading = headings.find(element => element.tag === 'h1') ?? headings[0];
  const primaryParagraph = paragraphs[0];
  const primaryActions = links.slice(0, 4).map(element => actionFromElement(element)).filter((action): action is SemanticAction => Boolean(action));

  if (primaryHeading || primaryParagraph || snapshot.title) {
    const sourceElements = [primaryHeading, primaryParagraph, ...links.slice(0, 4)].filter((element): element is RawElement => Boolean(element));
    sourceElements.forEach(element => consumed.add(element.id));
    objects.push({
      id: 'document-primary',
      type: 'document',
      label: 'Document',
      title: primaryHeading?.text || snapshot.title || 'Untitled document',
      description: primaryParagraph?.text,
      actions: primaryActions,
      provenance: provenance(snapshot, sourceElements)
    });
  }

  const secondaryHeadings = headings.filter(element => element !== primaryHeading).slice(0, 8);
  for (const heading of secondaryHeadings) {
    const headingY = heading.bbox[1];
    const nextParagraph = paragraphs.find(element => !consumed.has(element.id) && element.bbox[1] >= headingY);
    const sourceElements = [heading, nextParagraph].filter((element): element is RawElement => Boolean(element));
    sourceElements.forEach(element => consumed.add(element.id));
    objects.push({
      id: `section-${heading.id}`,
      type: 'section',
      label: 'Section',
      title: heading.text,
      description: nextParagraph?.text,
      actions: [],
      provenance: provenance(snapshot, sourceElements)
    });
  }

  if (controls.length) {
    const formButtons = buttons.slice(0, 3);
    const sourceElements = [...controls.slice(0, 12), ...formButtons];
    sourceElements.forEach(element => consumed.add(element.id));
    const fields = controls.slice(0, 10).map(element => element.placeholder || element.text || element.inputType || element.tag);
    objects.push({
      id: 'form-primary',
      type: 'form',
      label: 'Form',
      title: fields.length === 1 ? fields[0] : `${fields.length} fields`,
      items: fields,
      actions: formButtons.map(element => actionFromElement(element)).filter((action): action is SemanticAction => Boolean(action)),
      provenance: provenance(snapshot, sourceElements)
    });
  }

  const remainingLinks = links.filter(element => !consumed.has(element.id));
  if (remainingLinks.length >= 2) {
    const navigationLinks = remainingLinks.slice(0, 12);
    navigationLinks.forEach(element => consumed.add(element.id));
    objects.push({
      id: 'navigation-primary',
      type: 'navigation',
      label: 'Navigation',
      title: `${navigationLinks.length} links`,
      items: navigationLinks.map(element => element.text),
      actions: navigationLinks.map(element => actionFromElement(element)).filter((action): action is SemanticAction => Boolean(action)),
      provenance: provenance(snapshot, navigationLinks)
    });
  }

  for (const element of buttons.filter(element => !consumed.has(element.id)).slice(0, 8)) {
    const action = actionFromElement(element);
    if (!action) continue;
    objects.push({
      id: `action-${element.id}`,
      type: 'action',
      label: 'Action',
      title: element.text,
      actions: [action],
      provenance: provenance(snapshot, [element])
    });
  }

  return objects.length ? objects : [{
    id: 'document-fallback',
    type: 'document',
    label: 'Document',
    title: snapshot.title || snapshot.url,
    text: elements.slice(0, 6).map(element => element.text).filter(Boolean).join(' Â· '),
    actions: [],
    provenance: provenance(snapshot, elements.slice(0, 6))
  }];
}

function buildSemanticModel(snapshot: Snapshot): SemanticModel {
  const sourceKind = sourceKindForUrl(snapshot.url);
  let semanticObjects: SemanticObject[] = [];
  if (sourceKind === 'gmail') semanticObjects = buildGmailObjects(snapshot);
  if (sourceKind === 'gdrive') semanticObjects = buildDriveObjects(snapshot);
  if (sourceKind === 'google-search') semanticObjects = buildGoogleSearchObjects(snapshot);
  if (!semanticObjects.length) semanticObjects = buildGenericObjects(snapshot);
  return { sourceKind, semanticObjects };
}

async function snapshotPage(page: Page): Promise<Snapshot> {
  return page.evaluate((selector) => {
    const candidates = Array.from(document.querySelectorAll(selector));
    const elements = candidates.slice(0, 700).map((el, sourceIndex) => {
      const node = el as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const text = ((node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '') as string)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 420);
      const role = node.getAttribute('role') || node.tagName.toLowerCase();
      const input = node instanceof HTMLInputElement ? node : null;
      return {
        id: `e${sourceIndex}`,
        sourceIndex,
        tag: node.tagName.toLowerCase(),
        role,
        text,
        href: node instanceof HTMLAnchorElement ? node.href : null,
        inputType: input?.type ?? null,
        placeholder: input?.placeholder || node.getAttribute('placeholder'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
      };
    }).filter(element => element.visible && (element.text || ['input', 'select', 'textarea', 'button', 'a'].includes(element.tag)));

    return {
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      elements
    };
  }, SEMANTIC_SELECTOR);
}


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


type RecipeState = {
  status: 'hit' | 'miss' | 'stale';
  recipeId?: string;
  score?: number;
  diagnostics?: string[];
  cacheKey?: string;
  route?: string;
};

async function semanticModelForProviderTarget(
  provider: BrowserProvider,
  targetId: string,
  snapshot: Snapshot,
): Promise<SemanticModel & { recipe: RecipeState }> {
  const recipe = await siteRecipeStore.find(snapshot.url);
  if (recipe) {
    try {
      const execution = await executeSiteRecipe(provider, targetId, recipe);
      if (execution.healthy && execution.semanticObjects.length) {
        return {
          sourceKind: sourceKindForUrl(snapshot.url),
          semanticObjects: execution.semanticObjects as SemanticObject[],
          recipe: {
            status: 'hit',
            recipeId: execution.recipeId,
            score: execution.score,
            diagnostics: execution.diagnostics,
          },
        };
      }
      const fallback = buildSemanticModel(snapshot);
      return {
        ...fallback,
        recipe: {
          status: 'stale',
          recipeId: recipe.id,
          score: execution.score,
          diagnostics: execution.diagnostics,
          ...siteRecipeStore.cacheHint(snapshot.url),
        },
      };
    } catch (error) {
      const fallback = buildSemanticModel(snapshot);
      return {
        ...fallback,
        recipe: {
          status: 'stale',
          recipeId: recipe.id,
          diagnostics: [String(error)],
          ...siteRecipeStore.cacheHint(snapshot.url),
        },
      };
    }
  }

  return {
    ...buildSemanticModel(snapshot),
    recipe: { status: 'miss', ...siteRecipeStore.cacheHint(snapshot.url) },
  };
}

app.get('/api/recipes', async (_req, res) => {
  try {
    res.json({ ok: true, recipes: await siteRecipeStore.list() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/recipes', async (req, res) => {
  try {
    const recipe = req.body as SiteRecipe;
    if (recipe?.schemaVersion !== 1 || !recipe.host || !recipe.routePattern || !Array.isArray(recipe.widgets)) {
      throw new Error('Invalid SiteRecipe');
    }
    const filePath = await siteRecipeStore.save(recipe);
    res.json({ ok: true, recipe, filePath });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.post('/api/providers/:providerId/discovery', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const targetId = String(req.body?.targetId || '');
    if (!targetId) throw new Error('targetId is required');
    const discovery = await buildDiscoverySnapshot(provider, targetId);
    const cached = await siteRecipeStore.find(discovery.url);
    res.json({
      ok: true,
      discovery,
      cachedRecipe: cached,
      cache: siteRecipeStore.cacheHint(discovery.url),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});


app.post('/api/providers/:providerId/structure-query', async (req, res) => {
  try {
    const provider = browserRegistry.get(String(req.params.providerId));
    const targetId = String(req.body?.targetId || '');
    const selectors = Array.isArray(req.body?.selectors)
      ? req.body.selectors.map((value: unknown) => String(value)).filter(Boolean).slice(0, 32)
      : [];
    if (!targetId) throw new Error('targetId is required');
    if (!selectors.length) throw new Error('selectors[] is required');
    const encoded = JSON.stringify(selectors);
    const expression = `(() => {
      const selectors = ${encoded};
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      return selectors.map(selector => {
        try {
          const all = Array.from(document.querySelectorAll(selector));
          const nodes = all.filter(visible);
          return {
            selector,
            count: all.length,
            visibleCount: nodes.length,
            samples: nodes.slice(0, 5).map(el => {
              const r = el.getBoundingClientRect();
              return {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                id: el.id || '',
                classTokens: String(el.className || '').split(/\\s+/).filter(Boolean).filter(c => c.length < 70).slice(0, 8),
                attributeNames: Array.from(el.attributes).map(a => a.name).filter(name => !name.startsWith('data-') || name.length < 45).slice(0, 20),
                bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                childCount: el.children.length,
                interactiveCount: el.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]').length,
                textLength: String(el.innerText || '').trim().length,
              };
            }),
          };
        } catch (error) {
          return { selector, count: 0, visibleCount: 0, samples: [], error: String(error) };
        }
      });
    })()`;
    const queries = await provider.evaluate(targetId, expression);
    res.json({ ok: true, targetId, queries });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

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
    const model = await semanticModelForProviderTarget(provider, target.targetId, snapshot);
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
    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);
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
      if (action.selector) {
        const selector = JSON.stringify(action.selector);
        const itemIndex = Number.isInteger(action.itemIndex) ? Number(action.itemIndex) : 0;
        await provider.evaluate(targetId, `(() => { const nodes=Array.from(document.querySelectorAll(${selector})); const node=nodes[${itemIndex}]; if(!node) throw new Error('Recipe action element not found'); node.click(); return true; })()`);
      } else {
        if (!Number.isInteger(action.sourceIndex)) throw new Error('Click action requires sourceIndex or recipe selector');
        const selector = JSON.stringify(SEMANTIC_SELECTOR);
        const index = Number(action.sourceIndex);
        await provider.evaluate(targetId, `(() => { const nodes=Array.from(document.querySelectorAll(${selector})); const node=nodes[${index}]; if(!node) throw new Error('Source element not found'); node.click(); return true; })()`);
      }
      await new Promise(resolve => setTimeout(resolve, 650));
    }

    const snapshot = await snapshotProviderTarget(provider, targetId);
    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);
    res.json({ ok: true, targetId, snapshot, ...model });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, browserConnected: Boolean(context), pages: pages().length });
});

app.post('/api/browser/launch', async (_req, res) => {
  try {
    if (!context) {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        args: ['--start-maximized']
      });
      if (!context.pages().length) await context.newPage();
    }
    res.json({ ok: true, pages: await Promise.all(pages().map(async (page, index) => ({ index, title: await page.title(), url: page.url() }))) });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/browser/pages', async (_req, res) => {
  try {
    const data = await Promise.all(pages().map(async (page, index) => ({
      index,
      title: await page.title(),
      url: page.url(),
      selected: index === selectedPageIndex
    })));
    res.json({ ok: true, pages: data });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/browser/select', (req, res) => {
  try {
    pageAt(Number(req.body?.index));
    res.json({ ok: true, selectedPageIndex });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.post('/api/browser/open', async (req, res) => {
  try {
    const url = String(req.body?.url || 'https://example.com');
    if (!context) throw new Error('Launch Chrome first.');
    const page = reusableBlankPage() ?? await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    selectedPageIndex = pages().indexOf(page);
    res.json({ ok: true, index: selectedPageIndex, title: await page.title(), url: page.url() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/browser/snapshot', async (req, res) => {
  try {
    const page = pageAt(req.body?.index);
    const snapshot = await snapshotPage(page);
    const model = buildSemanticModel(snapshot);
    res.json({ ok: true, snapshot, ...model });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/browser/action', async (req, res) => {
  try {
    const page = pageAt(req.body?.index);
    const action = req.body?.action as SemanticAction | undefined;
    if (!action?.kind) throw new Error('Action is required.');

    if (action.kind === 'navigate') {
      if (!action.href) throw new Error('Navigate action requires href.');
      await page.goto(action.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else if (action.kind === 'click') {
      if (!Number.isInteger(action.sourceIndex)) throw new Error('Click action requires sourceIndex.');
      await page.locator(SEMANTIC_SELECTOR).nth(Number(action.sourceIndex)).click({ timeout: 10000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }

    selectedPageIndex = pages().indexOf(page);
    const snapshot = await snapshotPage(page);
    const model = buildSemanticModel(snapshot);
    res.json({
      ok: true,
      index: selectedPageIndex,
      title: await page.title(),
      url: page.url(),
      snapshot,
      ...model
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post('/api/browser/cdp', async (req, res) => {
  try {
    const page = pageAt(req.body?.index);
    const method = String(req.body?.method || '');
    if (!method) throw new Error('CDP method is required');
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send(method as any, req.body?.params || {});
      res.json({ ok: true, result });
    } finally {
      await session.detach();
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

const port = 4318;
app.listen(port, '127.0.0.1', () => {
  console.log(`AI Semantic Canvas bridge listening on http://127.0.0.1:${port}`);
});

