import { useMemo, useRef, useState } from 'react';

type PageInfo = { index: number; title: string; url: string; selected?: boolean };
type SemanticElement = { id: string; tag: string; role: string; text: string; href?: string | null; bbox: number[] };
type Snapshot = { title: string; url: string; viewport: { width: number; height: number }; elements: SemanticElement[] };
type Card = SemanticElement & { x: number; y: number };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function App() {
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [status, setStatus] = useState('Ready');
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const visibleCards = useMemo(() => cards.slice(0, 80), [cards]);

  async function refreshPages() {
    const data = await api<{ ok: true; pages: PageInfo[] }>('/api/browser/pages');
    setPages(data.pages);
    const current = data.pages.find(p => p.selected);
    if (current) setSelected(current.index);
  }

  async function launch() {
    setStatus('Launching Chrome…');
    await api('/api/browser/launch', { method: 'POST', body: '{}' });
    await refreshPages();
    setStatus('Chrome connected');
  }

  async function openExample() {
    setStatus('Opening example.com…');
    const data = await api<{ ok: true; index: number }>('/api/browser/open', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
    setSelected(data.index);
    await refreshPages();
    setStatus('Page opened');
  }

  async function selectPage(index: number) {
    await api('/api/browser/select', { method: 'POST', body: JSON.stringify({ index }) });
    setSelected(index);
    await refreshPages();
  }

  async function inspect() {
    setStatus('Dissecting DOM…');
    const data = await api<{ ok: true; snapshot: Snapshot }>('/api/browser/snapshot', { method: 'POST', body: JSON.stringify({ index: selected }) });
    setSnapshot(data.snapshot);
    setCards(data.snapshot.elements.map((element, i) => ({ ...element, x: 42 + (i % 4) * 255, y: 110 + Math.floor(i / 4) * 145 })));
    setStatus(`${data.snapshot.elements.length} semantic elements extracted`);
  }

  function pointerDown(event: React.PointerEvent, card: Card) {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag.current = { id: card.id, dx: event.clientX - card.x, dy: event.clientY - card.y };
  }

  function pointerMove(event: React.PointerEvent) {
    if (!drag.current) return;
    const d = drag.current;
    setCards(prev => prev.map(card => card.id === d.id ? { ...card, x: event.clientX - d.dx, y: event.clientY - d.dy } : card));
  }

  function pointerUp() {
    drag.current = null;
  }

  return (
    <div className="app" onPointerMove={pointerMove} onPointerUp={pointerUp}>
      <aside className="sidebar">
        <div className="brand"><span className="orb" />AI Semantic Canvas</div>
        <p className="muted">Browser → semantic objects → fluid workspace</p>
        <div className="stack">
          <button onClick={launch}>Launch local Chrome</button>
          <button onClick={openExample}>Open example.com</button>
          <button className="primary" onClick={inspect}>Dissect selected page</button>
          <button onClick={refreshPages}>Refresh tabs</button>
        </div>
        <div className="sectionTitle">Tabs</div>
        <div className="tabs">
          {pages.map(page => (
            <button
              key={page.index}
              className={page.index === selected ? 'tab active' : 'tab'}
              onClick={() => selectPage(page.index)}
            >
              <strong>{page.title || 'Untitled'}</strong>
              <span>{page.url || 'about:blank'}</span>
            </button>
          ))}
        </div>
        <div className="status">{status}</div>
      </aside>

      <main className="canvas">
        <div className="canvasHeader">
          <div>
            <strong>{snapshot?.title || 'Semantic workspace'}</strong>
            <span>{snapshot?.url || 'Launch Chrome and inspect a page'}</span>
          </div>
          <div className="badge">{cards.length} objects</div>
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
            <div className="cardBox">{card.bbox.join(' · ')}</div>
          </article>
        ))}

        {!cards.length && (
          <div className="empty">
            <div className="emptyIcon">◎</div>
            <h1>The page is not the interface.</h1>
            <p>Connect a browser, dissect a page and its meaningful pieces will become movable semantic objects here.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
