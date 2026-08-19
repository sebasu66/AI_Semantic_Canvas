import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';

type PageInfo = { index: number; title: string; url: string; selected?: boolean };
type SemanticElement = { id: string; tag: string; role: string; text: string; href?: string | null; bbox: number[] };
type Snapshot = { title: string; url: string; viewport: { width: number; height: number }; elements: SemanticElement[] };
type Card = SemanticElement & { x: number; y: number };
type Health = { ok: true; browserConnected: boolean; pages: number };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'https://example.com';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function App() {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [status, setStatus] = useState('Workspace ready');
  const [browserConnected, setBrowserConnected] = useState(false);
  const [urlInput, setUrlInput] = useState('example.com');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const visibleCards = useMemo(() => cards.slice(0, 100), [cards]);
  const visiblePages = useMemo(() => pages.filter(page => page.url !== 'about:blank'), [pages]);

  useEffect(() => {
    let cancelled = false;

    async function pollBrowser() {
      try {
        const health = await api<Health>('/api/health');
        if (cancelled) return;
        setBrowserConnected(health.browserConnected);

        if (health.browserConnected) {
          const data = await api<{ ok: true; pages: PageInfo[] }>('/api/browser/pages');
          if (cancelled) return;
          setPages(data.pages);
          const current = data.pages.find(page => page.selected);
          if (current) setSelected(current.index);
        } else {
          setPages([]);
        }
      } catch {
        if (!cancelled) setBrowserConnected(false);
      }
    }

    void pollBrowser();
    const timer = window.setInterval(() => void pollBrowser(), 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function refreshPages(preferredIndex?: number) {
    const data = await api<{ ok: true; pages: PageInfo[] }>('/api/browser/pages');
    setPages(data.pages);
    if (Number.isInteger(preferredIndex)) {
      setSelected(Number(preferredIndex));
      return;
    }
    const current = data.pages.find(page => page.selected);
    if (current) setSelected(current.index);
  }

  async function ensureBrowser() {
    if (browserConnected) return;
    setStatus('Starting controlled browser…');
    const data = await api<{ ok: true; pages: PageInfo[] }>('/api/browser/launch', { method: 'POST', body: '{}' });
    setBrowserConnected(true);
    setPages(data.pages);
  }

  async function extractPage(index: number) {
    setStatus('Understanding page structure…');
    const data = await api<{ ok: true; snapshot: Snapshot }>('/api/browser/snapshot', {
      method: 'POST',
      body: JSON.stringify({ index })
    });
    setSnapshot(data.snapshot);
    setCards(data.snapshot.elements.map((element, i) => ({
      ...element,
      x: 38 + (i % 5) * 244,
      y: 104 + Math.floor(i / 5) * 138
    })));
    setStatus(`${data.snapshot.elements.length} semantic objects extracted`);
  }

  async function openAndExtract(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    try {
      await ensureBrowser();
      const url = normalizeUrl(urlInput);
      setStatus(`Opening ${url}…`);
      const opened = await api<{ ok: true; index: number; title: string; url: string }>('/api/browser/open', {
        method: 'POST',
        body: JSON.stringify({ url })
      });
      setSelected(opened.index);
      setUrlInput(opened.url);
      await refreshPages(opened.index);
      await extractPage(opened.index);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function connectBrowser() {
    setBusy(true);
    try {
      await ensureBrowser();
      await refreshPages();
      setStatus('Controlled browser connected');
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectPage(index: number) {
    setBusy(true);
    try {
      await api<{ ok: true; selectedPageIndex: number }>('/api/browser/select', {
        method: 'POST',
        body: JSON.stringify({ index })
      });
      setSelected(index);
      await refreshPages(index);
      await extractPage(index);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  function pointerDown(event: ReactPointerEvent, card: Card) {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag.current = { id: card.id, dx: event.clientX - card.x, dy: event.clientY - card.y };
  }

  function pointerMove(event: ReactPointerEvent) {
    if (!drag.current) return;
    const current = drag.current;
    setCards(previous => previous.map(card => (
      card.id === current.id
        ? { ...card, x: event.clientX - current.dx, y: event.clientY - current.dy }
        : card
    )));
  }

  function pointerUp() {
    drag.current = null;
  }

  return (
    <div className="app" onPointerMove={pointerMove} onPointerUp={pointerUp}>
      <aside className="sidebar">
        <div className="brand"><span className="orb" />AI Semantic Canvas</div>
        <p className="muted">Internet as semantic objects, not rectangular pages.</p>

        <div className="connectionRow">
          <span className={browserConnected ? 'connectionDot online' : 'connectionDot'} />
          <div>
            <strong>{browserConnected ? 'Controlled browser' : 'Browser disconnected'}</strong>
            <span>{browserConnected ? 'Live and observable' : 'Starts automatically when needed'}</span>
          </div>
          {!browserConnected && (
            <button className="miniButton" onClick={connectBrowser} disabled={busy}>Connect</button>
          )}
        </div>

        <form className="urlForm" onSubmit={openAndExtract}>
          <label htmlFor="url-input">Open a web source</label>
          <div className="urlRow">
            <input
              id="url-input"
              value={urlInput}
              onChange={event => setUrlInput(event.target.value)}
              placeholder="example.com"
              spellCheck={false}
            />
            <button className="goButton" type="submit" disabled={busy}>→</button>
          </div>
          <span className="formHint">Open + understand + place objects on canvas</span>
        </form>

        <div className="sectionTitle">Live browser sources</div>
        <div className="tabs">
          {visiblePages.length === 0 && <div className="noTabs">No web sources yet.</div>}
          {visiblePages.map(page => (
            <button
              key={`${page.index}-${page.url}`}
              className={page.index === selected ? 'tab active' : 'tab'}
              onClick={() => selectPage(page.index)}
              disabled={busy}
            >
              <strong>{page.title || 'Untitled'}</strong>
              <span>{page.url}</span>
            </button>
          ))}
        </div>

        <div className="status"><span className={busy ? 'pulse' : ''} />{status}</div>
      </aside>

      <main className="canvas">
        <div className="canvasHeader">
          <div className="workspaceIdentity">
            <span className="workspaceKicker">WORKSPACE</span>
            <strong>{snapshot?.title || 'Semantic workspace'}</strong>
            <span>{snapshot?.url || 'Open a web source. Its meaningful pieces will appear here.'}</span>
          </div>
          <div className="headerStats">
            <span className="sourceBadge">{browserConnected ? 'BROWSER LIVE' : 'BROWSER OFFLINE'}</span>
            <div className="badge">{cards.length} objects</div>
          </div>
        </div>

        {visibleCards.map(card => (
          <article
            key={card.id}
            className="semanticCard"
            style={{ left: card.x, top: card.y }}
            onPointerDown={event => pointerDown(event, card)}
          >
            <div className="cardMeta"><span>{card.role}</span><code>{card.id}</code></div>
            <div className="cardText">{card.text || `<${card.tag}>`}</div>
            {card.href && <div className="cardHref">{card.href}</div>}
            <div className="cardBox">source box · {card.bbox.join(' · ')}</div>
          </article>
        ))}

        {!cards.length && (
          <div className="empty">
            <div className="emptyIcon">◎</div>
            <h1>The page is not the interface.</h1>
            <p>Type a URL on the left. The browser opens it, the semantic layer understands it, and the useful pieces become objects in this workspace.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
