import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';

type PageInfo = { index: number; title: string; url: string; selected?: boolean };
type RawElement = {
  id: string;
  sourceIndex: number;
  tag: string;
  role: string;
  text: string;
  href?: string | null;
  inputType?: string | null;
  placeholder?: string | null;
  bbox: number[];
};
type Snapshot = { title: string; url: string; viewport: { width: number; height: number }; elements: RawElement[] };
type SemanticAction = {
  id: string;
  kind: 'navigate' | 'click';
  label: string;
  href?: string;
  sourceElementId?: string;
  sourceIndex?: number;
};
type SemanticObject = {
  id: string;
  type: 'document' | 'section' | 'navigation' | 'form' | 'action';
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
type PositionedSemanticObject = SemanticObject & { x: number; y: number };
type RawCard = RawElement & { x: number; y: number };
type Health = { ok: true; browserConnected: boolean; pages: number };
type SnapshotResponse = { ok: true; snapshot: Snapshot; semanticObjects: SemanticObject[] };
type ActionResponse = SnapshotResponse & { index: number; title: string; url: string };

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

function pageKey(url: string): string {
  return url.replace(/\/$/, '').toLowerCase();
}

function layoutSemantic(objects: SemanticObject[]): PositionedSemanticObject[] {
  return objects.map((object, index) => ({
    ...object,
    x: 42 + (index % 4) * 310,
    y: 108 + Math.floor(index / 4) * 230
  }));
}

function layoutRaw(elements: RawElement[]): RawCard[] {
  return elements.map((element, index) => ({
    ...element,
    x: 38 + (index % 5) * 244,
    y: 104 + Math.floor(index / 5) * 138
  }));
}

function App() {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [objects, setObjects] = useState<PositionedSemanticObject[]>([]);
  const [rawCards, setRawCards] = useState<RawCard[]>([]);
  const [debugDom, setDebugDom] = useState(false);
  const [status, setStatus] = useState('Workspace ready');
  const [browserConnected, setBrowserConnected] = useState(false);
  const [urlInput, setUrlInput] = useState('example.com');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number; layer: 'semantic' | 'raw' } | null>(null);

  const visiblePages = useMemo(() => {
    const deduped = new Map<string, PageInfo>();
    for (const page of pages) {
      if (page.url === 'about:blank') continue;
      const key = pageKey(page.url);
      const previous = deduped.get(key);
      if (!previous || page.selected) deduped.set(key, page);
    }
    return Array.from(deduped.values());
  }, [pages]);

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

  function applySnapshot(data: SnapshotResponse) {
    setSnapshot(data.snapshot);
    setObjects(layoutSemantic(data.semanticObjects));
    setRawCards(layoutRaw(data.snapshot.elements));
    setUrlInput(data.snapshot.url);
    setStatus(`${data.semanticObjects.length} semantic objects · ${data.snapshot.elements.length} DOM nodes`);
  }

  async function extractPage(index: number) {
    setStatus('Building semantic model…');
    const data = await api<SnapshotResponse>('/api/browser/snapshot', {
      method: 'POST',
      body: JSON.stringify({ index })
    });
    applySnapshot(data);
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

  async function runAction(action: SemanticAction) {
    setBusy(true);
    setStatus(`${action.kind === 'navigate' ? 'Navigating' : 'Executing'}: ${action.label}…`);
    try {
      const data = await api<ActionResponse>('/api/browser/action', {
        method: 'POST',
        body: JSON.stringify({ index: selected, action })
      });
      setSelected(data.index);
      applySnapshot(data);
      await refreshPages(data.index);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  function pointerDown(event: ReactPointerEvent, id: string, x: number, y: number, layer: 'semantic' | 'raw') {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag.current = { id, dx: event.clientX - x, dy: event.clientY - y, layer };
  }

  function pointerMove(event: ReactPointerEvent) {
    if (!drag.current) return;
    const current = drag.current;
    if (current.layer === 'semantic') {
      setObjects(previous => previous.map(object => (
        object.id === current.id
          ? { ...object, x: event.clientX - current.dx, y: event.clientY - current.dy }
          : object
      )));
    } else {
      setRawCards(previous => previous.map(card => (
        card.id === current.id
          ? { ...card, x: event.clientX - current.dx, y: event.clientY - current.dy }
          : card
      )));
    }
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
          <span className="formHint">Open → understand → expose data + actions</span>
        </form>

        <div className="sectionTitle">Live browser sources</div>
        <div className="tabs">
          {visiblePages.length === 0 && <div className="noTabs">No web sources yet.</div>}
          {visiblePages.map(page => (
            <button
              key={pageKey(page.url)}
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
            <span>{snapshot?.url || 'Open a web source. Its useful data and actions will appear here.'}</span>
          </div>
          <div className="headerStats">
            <button className={debugDom ? 'inspectToggle active' : 'inspectToggle'} onClick={() => setDebugDom(value => !value)}>
              {debugDom ? 'Semantic view' : 'Inspect DOM'}
            </button>
            <span className="sourceBadge">{browserConnected ? 'BROWSER LIVE' : 'BROWSER OFFLINE'}</span>
            <div className="badge">{debugDom ? `${rawCards.length} nodes` : `${objects.length} objects`}</div>
          </div>
        </div>

        {!debugDom && objects.map(object => (
          <article
            key={object.id}
            className={`semanticEntity semantic-${object.type}`}
            style={{ left: object.x, top: object.y }}
            onPointerDown={event => pointerDown(event, object.id, object.x, object.y, 'semantic')}
          >
            <div className="entityMeta">
              <span>{object.label}</span>
              <code>{object.id}</code>
            </div>
            {object.title && <h2>{object.title}</h2>}
            {object.description && <p>{object.description}</p>}
            {object.text && <p>{object.text}</p>}
            {object.items?.length ? (
              <div className="entityItems">
                {object.items.slice(0, 6).map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
              </div>
            ) : null}
            {object.actions.length > 0 && (
              <div className="entityActions">
                {object.actions.slice(0, 5).map(action => (
                  <button
                    key={action.id}
                    disabled={busy}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={() => void runAction(action)}
                    title={action.href || action.kind}
                  >
                    {action.label}<span>→</span>
                  </button>
                ))}
              </div>
            )}
            <div className="provenanceRow" title={object.provenance.url}>
              <span>source</span>
              <strong>{object.provenance.elementIds.length} DOM node{object.provenance.elementIds.length === 1 ? '' : 's'}</strong>
            </div>
          </article>
        ))}

        {debugDom && rawCards.slice(0, 100).map(card => (
          <article
            key={card.id}
            className="semanticCard rawCard"
            style={{ left: card.x, top: card.y }}
            onPointerDown={event => pointerDown(event, card.id, card.x, card.y, 'raw')}
          >
            <div className="cardMeta"><span>{card.role}</span><code>{card.id}</code></div>
            <div className="cardText">{card.text || `<${card.tag}>`}</div>
            {card.href && <div className="cardHref">{card.href}</div>}
            <div className="cardBox">source box · {card.bbox.join(' · ')}</div>
          </article>
        ))}

        {!objects.length && !rawCards.length && (
          <div className="empty">
            <div className="emptyIcon">◎</div>
            <h1>The page is not the interface.</h1>
            <p>Type a URL on the left. The browser opens it, the semantic layer understands it, and useful information plus live actions become objects here.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
