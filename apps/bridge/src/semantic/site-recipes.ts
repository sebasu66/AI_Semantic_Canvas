import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserProvider } from '../browser/types.js';

export type RecipeField = {
  name: string;
  selector?: string;
  attribute?: string;
  maxLength?: number;
};

export type RecipeValue = {
  static?: string;
  selector?: string;
  attribute?: string;
  property?: 'value' | 'textContent' | 'currentSrc' | 'poster';
  fallback?: string;
  maxLength?: number;
};

export type RecipeItemAction = {
  kind: 'click' | 'navigate';
  selector?: string;
  hrefField?: string;
  labelField?: string;
  label?: string;
};

export type SiteWidgetRecipe = {
  id: string;
  type: string;
  label: string;
  representation?: 'data' | 'live-region' | 'hybrid';
  root?: string;
  title?: RecipeValue;
  description?: RecipeValue;
  itemSelector?: string;
  fields?: RecipeField[];
  displayFields?: string[];
  itemAction?: RecipeItemAction;
  maxItems?: number;
  minItems?: number;
};

export type SiteRecipe = {
  schemaVersion: 1;
  id: string;
  host: string;
  routePattern: string;
  generatedBy: 'ai' | 'manual' | 'builtin';
  generatedAt: string;
  model?: string;
  notes?: string;
  validation?: {
    mustExist?: string[];
    minWidgetCount?: number;
  };
  widgets: SiteWidgetRecipe[];
};

export type RecipeSemanticAction = {
  id: string;
  kind: 'navigate' | 'click';
  label: string;
  href?: string;
  selector?: string;
  itemIndex?: number;
};

export type RecipeSemanticObject = {
  id: string;
  type: string;
  label: string;
  representation?: 'data' | 'live-region' | 'hybrid';
  regionSelector?: string;
  imageUrl?: string;
  title?: string;
  description?: string;
  text?: string;
  items?: string[];
  actions: RecipeSemanticAction[];
  provenance: {
    url: string;
    pageTitle: string;
    elementIds: string[];
    boxes: number[][];
  };
};

export type RecipeExecution = {
  recipeId: string;
  healthy: boolean;
  score: number;
  semanticObjects: RecipeSemanticObject[];
  diagnostics: string[];
};

export type DiscoverySnapshot = {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  landmarks: Array<{
    tag: string;
    role: string;
    ariaLabel: string;
    id: string;
    classTokens: string[];
    bbox: number[];
    textSample: string;
    childCount: number;
    interactiveCount: number;
  }>;
  roleCounts: Record<string, number>;
  tagCounts: Record<string, number>;
};

function compactRoute(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    let pathname = url.pathname || '/';
    pathname = pathname
      .replace(/\b\d{2,}\b/g, ':id')
      .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/ig, ':uuid')
      .replace(/\/u\/\d+/g, '/u/:id');

    let hash = url.hash.replace(/^#/, '');
    if (hash) {
      hash = hash.split(/[/?&]/)[0] || '';
      hash = hash.replace(/\b\d{2,}\b/g, ':id');
    }
    return `${pathname}${hash ? `#${hash}` : ''}`;
  } catch {
    return '/';
  }
}

function recipeKeyForUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const raw = `${url.hostname.toLowerCase()}|${compactRoute(urlValue)}`;
    return createHash('sha1').update(raw).digest('hex').slice(0, 18);
  } catch {
    return createHash('sha1').update(urlValue).digest('hex').slice(0, 18);
  }
}

function routeMatches(pattern: string, route: string): boolean {
  if (pattern === '*' || pattern === route) return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/:id/g, '[^/#?]+')
    .replace(/:uuid/g, '[^/#?]+');
  try { return new RegExp(`^${escaped}$`, 'i').test(route); } catch { return false; }
}

export class SiteRecipeStore {
  readonly cacheDir: string;

  constructor(repoRoot: string) {
    this.cacheDir = path.join(repoRoot, '.runtime', 'site-recipes');
  }

  async init(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  async save(recipe: SiteRecipe): Promise<string> {
    await this.init();
    const key = createHash('sha1').update(`${recipe.host}|${recipe.routePattern}|${recipe.id}`).digest('hex').slice(0, 18);
    const filePath = path.join(this.cacheDir, `${key}.json`);
    await writeFile(filePath, JSON.stringify(recipe, null, 2), 'utf8');
    return filePath;
  }

  async list(): Promise<SiteRecipe[]> {
    await this.init();
    const files = (await readdir(this.cacheDir)).filter(name => name.endsWith('.json'));
    const recipes: SiteRecipe[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(path.join(this.cacheDir, file), 'utf8')) as SiteRecipe;
        if (parsed?.schemaVersion === 1 && parsed.host && parsed.widgets) recipes.push(parsed);
      } catch {
        // Ignore malformed cached recipes; discovery can regenerate them.
      }
    }
    return recipes;
  }

  async find(urlValue: string): Promise<SiteRecipe | null> {
    let host = '';
    try { host = new URL(urlValue).hostname.toLowerCase(); } catch { return null; }
    const route = compactRoute(urlValue);
    const recipes = await this.list();
    const matches = recipes.filter(recipe => recipe.host.toLowerCase() === host && routeMatches(recipe.routePattern, route));
    matches.sort((a, b) => b.routePattern.length - a.routePattern.length || b.generatedAt.localeCompare(a.generatedAt));
    return matches[0] ?? null;
  }

  cacheHint(urlValue: string) {
    return { key: recipeKeyForUrl(urlValue), route: compactRoute(urlValue) };
  }
}

export async function executeSiteRecipe(
  provider: BrowserProvider,
  targetId: string,
  recipe: SiteRecipe,
): Promise<RecipeExecution> {
  const encoded = JSON.stringify(recipe);
  const expression = `(() => {
    const recipe = ${encoded};
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const clean = (v, max=240) => String(v || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const readValue = (scope, spec) => {
      if (!spec) return '';
      if (spec.static) return clean(spec.static, spec.maxLength || 240);
      const el = spec.selector ? scope.querySelector(spec.selector) : scope;
      if (!el) return spec.fallback || '';
      let raw = '';
      if (spec.attribute) raw = el.getAttribute(spec.attribute) || '';
      else if (spec.property && ['value','textContent','currentSrc','poster'].includes(spec.property)) raw = el[spec.property] || '';
      else raw = el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      return clean(raw, spec.maxLength || 240) || spec.fallback || '';
    };
    const objects = [];
    const diagnostics = [];
    let checks = 0;
    let passed = 0;

    for (const selector of (recipe.validation?.mustExist || [])) {
      checks += 1;
      if (document.querySelector(selector)) passed += 1;
      else diagnostics.push('missing:' + selector);
    }

    for (const widget of recipe.widgets) {
      const root = widget.root ? document.querySelector(widget.root) : document;
      checks += 1;
      if (!root) { diagnostics.push('root-missing:' + widget.id); continue; }
      passed += 1;

      const title = readValue(root, widget.title);
      const description = readValue(root, widget.description);
      const items = [];
      const actions = [];
      const boxes = [];
      const elementIds = [];

      if (widget.itemSelector) {
        const candidates = Array.from(root.querySelectorAll(widget.itemSelector)).filter(visible).slice(0, widget.maxItems || 20);
        checks += 1;
        if (candidates.length >= (widget.minItems || 1)) passed += 1;
        else diagnostics.push('too-few-items:' + widget.id + ':' + candidates.length);

        candidates.forEach((item, itemIndex) => {
          const values = {};
          for (const field of (widget.fields || [])) {
            const target = field.selector ? item.querySelector(field.selector) : item;
            let value = '';
            if (target) {
              value = field.attribute ? target.getAttribute(field.attribute) : (target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || '');
            }
            values[field.name] = clean(value, field.maxLength || 180);
          }
          const displayFields = widget.displayFields?.length ? widget.displayFields : (widget.fields || []).map(f => f.name);
          const display = displayFields.map(name => values[name]).filter(Boolean).join(' — ');
          if (display) items.push(display);

          const rect = item.getBoundingClientRect();
          boxes.push([Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]);
          elementIds.push(widget.itemSelector + ':nth(' + itemIndex + ')');

          if (widget.itemAction) {
            let href = '';
            if (widget.itemAction.hrefField) href = values[widget.itemAction.hrefField] || '';
            const label = widget.itemAction.label || (widget.itemAction.labelField ? values[widget.itemAction.labelField] : '') || display || 'Open';
            actions.push({
              id: widget.id + '-action-' + itemIndex,
              kind: widget.itemAction.kind,
              label: clean(label, 100),
              ...(href ? { href } : {}),
              selector: widget.itemAction.selector || widget.itemSelector,
              itemIndex,
            });
          }
        });
      } else {
        const rect = root.getBoundingClientRect ? root.getBoundingClientRect() : { x:0,y:0,width:0,height:0 };
        boxes.push([Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]);
        elementIds.push(widget.root || 'document');
      }

      objects.push({
        id: widget.id,
        type: widget.type,
        label: widget.label,
        representation: widget.representation || 'data',
        ...(widget.representation === 'live-region' || widget.representation === 'hybrid' ? { regionSelector: widget.root || 'body' } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(items.length ? { items } : {}),
        actions,
        provenance: {
          url: location.href,
          pageTitle: document.title,
          elementIds,
          boxes,
        },
      });
    }

    if (recipe.validation?.minWidgetCount) {
      checks += 1;
      if (objects.length >= recipe.validation.minWidgetCount) passed += 1;
      else diagnostics.push('too-few-widgets:' + objects.length);
    }

    const score = checks ? passed / checks : (objects.length ? 1 : 0);
    return { recipeId: recipe.id, healthy: objects.length > 0 && score >= 0.6, score, semanticObjects: objects, diagnostics };
  })()`;
  return await provider.evaluate<RecipeExecution>(targetId, expression);
}

export async function buildDiscoverySnapshot(
  provider: BrowserProvider,
  targetId: string,
): Promise<DiscoverySnapshot> {
  const expression = `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const clean = (v, max=100) => String(v || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const selector = 'main,[role=main],[role=grid],[role=table],[role=list],[role=listbox],[role=feed],[role=search],form,article,section,video,[data-testid],[aria-label]';
    const all = Array.from(document.querySelectorAll(selector)).filter(visible);
    const roleCounts = {};
    const tagCounts = {};
    for (const el of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
      const role = el.getAttribute('role') || '';
      if (role) roleCounts[role] = (roleCounts[role] || 0) + 1;
      const tag = el.tagName.toLowerCase();
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    const landmarks = all.slice(0, 220).map(el => {
      const r = el.getBoundingClientRect();
      const classes = String(el.className || '').split(/\\s+/).filter(Boolean).filter(c => c.length < 70).slice(0, 6);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        ariaLabel: clean(el.getAttribute('aria-label'), 80),
        id: clean(el.id, 80),
        classTokens: classes,
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        textSample: clean(el.innerText || el.getAttribute('title') || '', 100),
        childCount: el.children.length,
        interactiveCount: el.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]').length,
      };
    });
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      landmarks,
      roleCounts,
      tagCounts,
    };
  })()`;
  return await provider.evaluate<DiscoverySnapshot>(targetId, expression);
}
