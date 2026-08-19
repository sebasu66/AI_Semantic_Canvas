from pathlib import Path

# BrowserProvider interface
p = Path('apps/bridge/src/browser/types.ts')
s = p.read_text(encoding='utf-8')
needle = "  evaluate<T = unknown>(targetId: string, expression: string): Promise<T>;\n"
if "captureRegion?" not in s:
    s = s.replace(needle, needle + "  captureRegion?(targetId: string, selector: string): Promise<string | null>;\n")
p.write_text(s, encoding='utf-8')

# Harness REPL client
p = Path('apps/bridge/src/browser/harness-repl.ts')
s = p.read_text(encoding='utf-8')
marker = "  async closeTarget(targetId: string): Promise<void> {"
method = r'''  async captureRegion(targetId: string, selector: string): Promise<string | null> {
    const tid = JSON.stringify(targetId);
    const selectorLiteral = JSON.stringify(selector);
    const expression = `(() => {
      const el = document.querySelector(${selectorLiteral});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, r.left + scrollX),
        y: Math.max(0, r.top + scrollY),
        width: Math.max(1, Math.min(r.width, 1400)),
        height: Math.max(1, Math.min(r.height, 900)),
      };
    })()`;
    const expr = JSON.stringify(expression);
    return await this.eval<string | null>(`
await session.use(${tid});
await session.Page.enable();
const rr=await session.Runtime.evaluate({expression:${expr},returnByValue:true});
const clip=rr?.result?.value;
if(!clip || clip.width < 2 || clip.height < 2) return null;
const shot=await session.Page.captureScreenshot({format:'jpeg',quality:78,fromSurface:true,captureBeyondViewport:true,clip:{x:clip.x,y:clip.y,width:clip.width,height:clip.height,scale:1}});
return shot?.data ? 'data:image/jpeg;base64,' + shot.data : null;
`, 45_000);
  }

'''
if "async captureRegion(" not in s:
    s = s.replace(marker, method + marker)
p.write_text(s, encoding='utf-8')

# Local Harness provider
p = Path('apps/bridge/src/browser/providers/local-harness.ts')
s = p.read_text(encoding='utf-8')
marker = "  async closeTarget(targetId: string): Promise<void> {"
method = "  async captureRegion(targetId: string, selector: string): Promise<string | null> {\n    await this.ensureConnected();\n    return await this.repl.captureRegion(targetId, selector);\n  }\n\n"
if "async captureRegion(" not in s:
    s = s.replace(marker, method + marker)
p.write_text(s, encoding='utf-8')

# Recipe semantic type
p = Path('apps/bridge/src/semantic/site-recipes.ts')
s = p.read_text(encoding='utf-8')
if "  imageUrl?: string;" not in s:
    s = s.replace("  regionSelector?: string;\n  title?: string;", "  regionSelector?: string;\n  imageUrl?: string;\n  title?: string;", 1)
p.write_text(s, encoding='utf-8')

# Bridge semantic object + media enrichment
p = Path('apps/bridge/src/index.ts')
s = p.read_text(encoding='utf-8-sig')
s = s.replace("  items?: string[];\n  actions: SemanticAction[];", "  items?: string[];\n  imageUrl?: string;\n  representation?: 'data' | 'live-region' | 'hybrid';\n  regionSelector?: string;\n  actions: SemanticAction[];", 1)
old = """      if (execution.healthy && execution.semanticObjects.length) {
        return {
          sourceKind: sourceKindForUrl(snapshot.url),
          semanticObjects: execution.semanticObjects as SemanticObject[],
          recipe: {
"""
new = """      if (execution.healthy && execution.semanticObjects.length) {
        const enriched = await Promise.all(execution.semanticObjects.map(async object => {
          if ((object.representation === 'live-region' || object.representation === 'hybrid') && object.regionSelector && provider.captureRegion) {
            try {
              const imageUrl = await provider.captureRegion(targetId, object.regionSelector);
              if (imageUrl) return { ...object, imageUrl };
            } catch {
              // Visual preview is best-effort; semantic data remains valid.
            }
          }
          return object;
        }));
        return {
          sourceKind: sourceKindForUrl(snapshot.url),
          semanticObjects: enriched as SemanticObject[],
          recipe: {
"""
if old in s:
    s = s.replace(old, new)
p.write_text(s, encoding='utf-8')
print('live-region preview integrated')
