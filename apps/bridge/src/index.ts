import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, BrowserContext, Page } from 'playwright';

const app = express();
app.use(express.json({ limit: '2mb' }));

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const profileDir = path.join(repoRoot, '.runtime', 'chrome-profile');

let context: BrowserContext | null = null;
let selectedPageIndex = 0;

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
    res.json({ ok: true, pages: await Promise.all(pages().map(async (p, index) => ({ index, title: await p.title(), url: p.url() }))) });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get('/api/browser/pages', async (_req, res) => {
  try {
    const data = await Promise.all(pages().map(async (p, index) => ({ index, title: await p.title(), url: p.url(), selected: index === selectedPageIndex })));
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

    // Chromium starts persistent contexts with an about:blank page. Reuse it
    // for the first navigation so the user does not see a mysterious empty tab.
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
    const snapshot = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role],[contenteditable="true"],h1,h2,h3,p,article,main,section'));
      const elements = candidates.slice(0, 250).map((el, index) => {
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const text = ((node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '') as string).replace(/\s+/g, ' ').trim().slice(0, 220);
        const role = node.getAttribute('role') || node.tagName.toLowerCase();
        return {
          id: `e${index}`,
          tag: node.tagName.toLowerCase(),
          role,
          text,
          href: node instanceof HTMLAnchorElement ? node.href : null,
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          bbox: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
        };
      }).filter(x => x.visible && (x.text || ['input','select','textarea','button','a'].includes(x.tag)));
      return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight }, elements };
    });
    res.json({ ok: true, snapshot });
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
