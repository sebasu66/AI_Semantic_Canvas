from pathlib import Path

p = Path('apps/bridge/src/index.ts')
s = p.read_text(encoding='utf-8-sig')

imp = "import { createBrowserRegistry } from './browser/registry.js';\n"
newimp = imp + "import { SiteRecipeStore, executeSiteRecipe, buildDiscoverySnapshot, type SiteRecipe } from './semantic/site-recipes.js';\n"
if "site-recipes.js" not in s:
    s = s.replace(imp, newimp)

needle = "const browserRegistry = createBrowserRegistry(repoRoot);\n"
if "new SiteRecipeStore" not in s:
    s = s.replace(needle, needle + "const siteRecipeStore = new SiteRecipeStore(repoRoot);\n")

s = s.replace("  sourceIndex?: number;\n};", "  sourceIndex?: number;\n  selector?: string;\n  itemIndex?: number;\n};", 1)

# Add provider-aware semantic resolver before provider routes.
marker = "app.get('/api/providers', async (_req, res) => {"
resolver = r'''
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

'''
if "semanticModelForProviderTarget" not in s:
    s = s.replace(marker, resolver + marker)

# Provider open/snapshot/action should use recipes.
s = s.replace("    const model = buildSemanticModel(snapshot);\n    res.json({ ok: true, target, snapshot, ...model });",
              "    const model = await semanticModelForProviderTarget(provider, target.targetId, snapshot);\n    res.json({ ok: true, target, snapshot, ...model });")
s = s.replace("    const model = buildSemanticModel(snapshot);\n    res.json({ ok: true, targetId, snapshot, ...model });",
              "    const model = await semanticModelForProviderTarget(provider, targetId, snapshot);\n    res.json({ ok: true, targetId, snapshot, ...model });")

old_click = """    } else {
      if (!Number.isInteger(action.sourceIndex)) throw new Error('Click action requires sourceIndex');
      const selector = JSON.stringify(SEMANTIC_SELECTOR);
      const index = Number(action.sourceIndex);
      await provider.evaluate(targetId, `(() => { const nodes=Array.from(document.querySelectorAll(${selector})); const node=nodes[${index}]; if(!node) throw new Error('Source element not found'); node.click(); return true; })()`);
      await new Promise(resolve => setTimeout(resolve, 650));
    }
"""
new_click = """    } else {
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
"""
if old_click in s:
    s = s.replace(old_click, new_click)

p.write_text(s, encoding='utf-8')
print('site recipe engine integrated')
