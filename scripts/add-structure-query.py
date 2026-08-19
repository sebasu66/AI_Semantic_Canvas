from pathlib import Path

p = Path('apps/bridge/src/index.ts')
s = p.read_text(encoding='utf-8-sig')
marker = "app.get('/api/providers', async (_req, res) => {"
block = r'''
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

'''
if "structure-query" not in s:
    s = s.replace(marker, block + marker)
p.write_text(s, encoding='utf-8')
print('structure query integrated')
