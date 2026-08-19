import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent } from 'react';

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
type SourceKind = 'web' | 'gmail' | 'gdrive' | 'google-search' | 'local-image';
type SemanticAction = {
  id: string;
  kind: 'navigate' | 'click';
  label: string;
  href?: string;
  sourceElementId?: string;
  sourceIndex?: number;
};
type SemanticObjectType =
  | 'document'
  | 'section'
  | 'navigation'
  | 'form'
  | 'action'
  | 'mail-list'
  | 'drive-grid'
  | 'search-results'
  | 'image';
type SemanticObject = {
  id: string;
  type: SemanticObjectType;
  label: string;
  title?: string;
  description?: string;
  text?: string;
  items?: string[];
  imageUrl?: string;
  actions: SemanticAction[];
  provenance: {
    url: string;
    pageTitle: string;
    elementIds: string[];
    boxes: number[][];
  };
};
type CanvasObject = SemanticObject & { x: number; y: number; sourceId: string };
type RawCard = RawElement & { x: number; y: number; sourceId: string };
type WorkspaceSource = {
  id: string;
  pageIndex?: number;
  title: string;
  url: string;
  kind: SourceKind;
  updatedAt: number;
};
type Health = { ok: true; browserConnected: boolean; pages: number };
type SnapshotResponse = { ok: true; snapshot: Snapshot; semanticObjects: SemanticObject[]; sourceKind: Exclude<SourceKind, 'local-image'> };
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

function kindLabel(kind: SourceKind): string {
  if (kind === 'gmail') return 'Gmail';
  if (kind === 'gdrive') return 'Drive';
  if (kind === 'google-search') return 'Google Search';
  if (kind === 'local-image') return 'Local image';
  return 'Web';
}

function layoutSemantic(
  objects: SemanticObject[],
  sourceId: string,
  sourceOrdinal: number,
  anchor?: { x: number; y: number }
): CanvasObject[] {
  const baseX = anchor?.x ?? 42 + (sourceOrdinal % 3) * 350;
  const baseY = anchor?.y ?? 112 + Math.floor(sourceOrdinal / 3) * 520;
  return objects.map((object, index) => ({
    ...object,
    sourceId,
    x: baseX,
    y: baseY + index * 250
  }));
}

function layoutRaw(elements: RawElement[], sourceId: string, sourceOrdinal: number): RawCard[] {
  const baseX = 38 + (sourceOrdinal % 3) * 350;
  const baseY = 110 + Math.floor(sourceOrdinal / 3) * 520;
  return elements.map((element, index) => ({
    ...element,
    sourceId,
    x: baseX + (index % 2) * 238,
    y: baseY + Math.floor(index / 2) * 136
  }));
}

function App() {
  const [sources, setSources] = useState<WorkspaceSource[]>([]);
  const [objects, setObjects] = useState<CanvasObject[]>([]);
  const [rawCards, setRawCards] = useState<RawCard[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [debugDom, setDebugDom] = useState(false);
  const [status, setStatus] = useState('Workspace ready');
  const [browserConnected, setBrowserConnected] = useState(false);
  const [urlInput, setUrlInput] = useState('example.com');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number; layer: 'semantic' | 'raw' } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const sourceMap = useMemo(() => new Map(sources.map(source => [source.id, source])), [sources]);
  const visibleObjects = useMemo(() => objects.slice(0, 160), [objects]);

  useEffect(() => {
    let cancelled = false;
    async function pollBrowser() {
      try {
        const health = await api<Health>('/api/health');
        if (!cancelled) setBrowserConnected(health.browserConnected);
      } catch {
        if (!cancelled) setBrowserConnected(false);
      }
    }
    void pollBrowser();
    const timer = window.setInterval(() => void pollBrowser(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function ensureBrowser() {
    if (browserConnected) return;
    setStatus('Starting controlled browser…');
    await api<{ ok: true; pages: PageInfo[] }>('/api/browser/launch', { method: 'POST', body: '{}' });
    setBrowserConnected(true);
  }

  function sourceAnchor(sourceId: string): { x: number; y: number } | undefined {
    const existing = objects.filter(object => object.sourceId === sourceId);
    if (!existing.length) return undefined;
    return {
      x: Math.min(...existing.map(object => object.x)),
      y: Math.min(...existing.map(object => object.y))
    };
  }

  function upsertSourceFromSnapshot(sourceId: string, pageIndex: number, data: SnapshotResponse, isNew: boolean) {
    const ordinal = isNew ? sources.length : Math.max(0, sources.findIndex(source => source.id === sourceId));
    const anchor = isNew ? undefined : sourceAnchor(sourceId);
    const nextObjects = layoutSemantic(data.semanticObjects, sourceId, ordinal, anchor);
    const nextRaw = layoutRaw(data.snapshot.elements, sourceId, ordinal);

    setObjects(previous => [...previous.filter(object => object.sourceId !== sourceId), ...nextObjects]);
    setRawCards(previous => [...previous.filter(card => card.sourceId !== sourceId), ...nextRaw]);
    setSources(previous => {
      const nextSource: WorkspaceSource = {
        id: sourceId,
        pageIndex,
        title: data.snapshot.title || data.snapshot.url,
        url: data.snapshot.url,
        kind: data.sourceKind,
        updatedAt: Date.now()
      };
      const index = previous.findIndex(source => source.id === sourceId);
      if (index < 0) return [...previous, nextSource];
      const copy = [...previous];
      copy[index] = nextSource;
      return copy;
    });
    setActiveSourceId(sourceId);
    setStatus(`${kindLabel(data.sourceKind)} added · ${data.semanticObjects.length} widget${data.semanticObjects.length === 1 ? '' : 's'}`);
  }

  async function snapshotPage(pageIndex: number): Promise<SnapshotResponse> {
    return api<SnapshotResponse>('/api/browser/snapshot', {
      method: 'POST',
      body: JSON.stringify({ index: pageIndex })
    });
  }

  async function addWebSource(urlValue: string) {
    await ensureBrowser();
    const url = normalizeUrl(urlValue);
    setStatus(`Opening ${url}…`);
    const opened = await api<{ ok: true; index: number; title: string; url: string }>('/api/browser/open', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    const data = await snapshotPage(opened.index);
    const sourceId = `browser-${opened.index}-${Date.now()}`;
    upsertSourceFromSnapshot(sourceId, opened.index, data, true);
    setUrlInput('');
  }

  async function openAndAdd(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    try {
      await addWebSource(urlInput);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function quickAdd(url: string) {
    setBusy(true);
    try {
      await addWebSource(url);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSource(sourceId: string) {
    const source = sourceMap.get(sourceId);
    if (source?.pageIndex === undefined) return;
    setBusy(true);
    setStatus(`Refreshing ${source.title}…`);
    try {
      const data = await snapshotPage(source.pageIndex);
      upsertSourceFromSnapshot(sourceId, source.pageIndex, data, false);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  function removeSource(sourceId: string) {
    const imageObjects = objects.filter(object => object.sourceId === sourceId && object.imageUrl);
    for (const object of imageObjects) {
      if (object.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(object.imageUrl);
    }
    setSources(previous => previous.filter(source => source.id !== sourceId));
    setObjects(previous => previous.filter(object => object.sourceId !== sourceId));
    setRawCards(previous => previous.filter(card => card.sourceId !== sourceId));
    setActiveSourceId(current => current === sourceId ? null : current);
    setStatus('Source removed from workspace');
  }

  function addLocalImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const sourceId = `local-image-${Date.now()}`;
    const imageUrl = URL.createObjectURL(file);
    const ordinal = sources.length;
    const source: WorkspaceSource = {
      id: sourceId,
      title: file.name,
      url: `local-file://${file.name}`,
      kind: 'local-image',
      updatedAt: Date.now()
    };
    const imageObject: SemanticObject = {
      id: 'image-primary',
      type: 'image',
      label: 'Image',
      title: file.name,
      description: `${Math.round(file.size / 1024)} KB · ${file.type || 'image'}`,
      imageUrl,
      actions: [],
      provenance: { url: source.url, pageTitle: file.name, elementIds: [], boxes: [] }
    };
    setSources(previous => [...previous, source]);
    setObjects(previous => [...previous, ...layoutSemantic([imageObject], sourceId, ordinal)]);
    setActiveSourceId(sourceId);
    setStatus(`Local image added: ${file.name}`);
  }

  async function runAction(sourceId: string, action: SemanticAction) {
    const source = sourceMap.get(sourceId);
    if (source?.pageIndex === undefined) return;
    setBusy(true);
    setStatus(`${action.kind === 'navigate' ? 'Opening' : 'Executing'} ${action.label}…`);
    try {
      const data = await api<ActionResponse>('/api/browser/action', {
        method: 'POST',
        body: JSON.stringify({ index: source.pageIndex, action })
      });
      upsertSourceFromSnapshot(sourceId, data.index, data, false);
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
        `${object.sourceId}-${object.id}` === current.id
          ? { ...object, x: event.clientX - current.dx, y: event.clientY - current.dy }
          : object
      )));
    } else {
      setRawCards(previous => previous.map(card => (
        `${card.sourceId}-${card.id}` === current.id
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
        <p className="muted">Many sources. One fluid workspace.</p>

        <div className="connectionRow">
          <span className={browserConnected ? 'connectionDot online' : 'connectionDot'} />
          <div>
            <strong>{browserConnected ? 'Controlled browser' : 'Browser disconnected'}</strong>
            <span>{browserConnected ? 'Live and observable' : 'Starts automatically when needed'}</span>
          </div>
        </div>

        <form className="urlForm" onSubmit={openAndAdd}>
          <label htmlFor="url-input">Add web source</label>
          <div className="urlRow">
            <input
              id="url-input"
              value={urlInput}
              onChange={event => setUrlInput(event.target.value)}
              placeholder="URL or site"
              spellCheck={false}
            />
            <button className="goButton" type="submit" disabled={busy}>+</button>
          </div>
          <span className="formHint">Each source adds widgets without replacing the canvas.</span>
        </form>

        <div className="quickSources">
          <button disabled={busy} onClick={() => void quickAdd('https://mail.google.com/mail/u/0/#inbox')}>Gmail</button>
          <button disabled={busy} onClick={() => void quickAdd('https://drive.google.com/drive/my-drive')}>Drive</button>
          <button disabled={busy} onClick={() => void quickAdd('https://www.google.com/search?q=AI+semantic+canvas')}>Search</button>
          <button disabled={busy} onClick={() => fileInput.current?.click()}>Image</button>
          <input ref={fileInput} className="hiddenFile" type="file" accept="image/*" onChange={addLocalImage} />
        </div>

        <div className="sectionTitle">Canvas sources · {sources.length}</div>
        <div className="sourceList">
          {sources.length === 0 && <div className="noTabs">Add Gmail, Drive, a search, a URL or a local image.</div>}
          {sources.map(source => (
            <div key={source.id} className={source.id === activeSourceId ? 'sourceItem active' : 'sourceItem'} onClick={() => setActiveSourceId(source.id)}>
              <div className="sourceItemTop">
                <span>{kindLabel(source.kind)}</span>
                <div>
                  {source.pageIndex !== undefined && <button disabled={busy} title="Refresh source" onClick={event => { event.stopPropagation(); void refreshSource(source.id); }}>↻</button>}
                  <button title="Remove from canvas" onClick={event => { event.stopPropagation(); removeSource(source.id); }}>×</button>
                </div>
              </div>
              <strong>{source.title}</strong>
              <small>{source.url}</small>
            </div>
          ))}
        </div>

        <div className="status"><span className={busy ? 'pulse' : ''} />{status}</div>
      </aside>

      <main className="canvas">
        <div className="canvasHeader">
          <div className="workspaceIdentity">
            <span className="workspaceKicker">WORKSPACE</span>
            <strong>Multi-source semantic canvas</strong>
            <span>{sources.length ? `${sources.length} live source${sources.length === 1 ? '' : 's'} composed into one workspace` : 'Add sources from the left. They stay together on this canvas.'}</span>
          </div>
          <div className="headerStats">
            <button className={debugDom ? 'inspectToggle active' : 'inspectToggle'} onClick={() => setDebugDom(value => !value)}>
              {debugDom ? 'Semantic view' : 'Inspect DOM'}
            </button>
            <span className="sourceBadge">{browserConnected ? 'BROWSER LIVE' : 'BROWSER OFFLINE'}</span>
            <div className="badge">{debugDom ? `${rawCards.length} nodes` : `${objects.length} widgets`}</div>
          </div>
        </div>

        {!debugDom && visibleObjects.map(object => {
          const source = sourceMap.get(object.sourceId);
          return (
            <article
              key={`${object.sourceId}-${object.id}`}
              className={`semanticEntity semantic-${object.type} ${object.sourceId === activeSourceId ? 'activeSourceWidget' : ''}`}
              style={{ left: object.x, top: object.y }}
              onPointerDown={event => pointerDown(event, `${object.sourceId}-${object.id}`, object.x, object.y, 'semantic')}
            >
              <div className="entityMeta">
                <span>{object.label}</span>
                <code>{source ? kindLabel(source.kind) : object.id}</code>
              </div>
              {object.imageUrl && <img className="widgetImage" src={object.imageUrl} alt={object.title || 'Local image'} draggable={false} />}
              {object.title && <h2>{object.title}</h2>}
              {object.description && <p>{object.description}</p>}
              {object.text && <p>{object.text}</p>}
              {object.items?.length ? (
                <div className="entityItems">
                  {object.items.slice(0, 10).map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
                </div>
              ) : null}
              {object.actions.length > 0 && (
                <div className="entityActions">
                  {object.actions.slice(0, 8).map(action => (
                    <button
                      key={action.id}
                      disabled={busy}
                      onPointerDown={event => event.stopPropagation()}
                      onClick={() => void runAction(object.sourceId, action)}
                      title={action.href || action.kind}
                    >
                      {action.label}<span>→</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="provenanceRow" title={object.provenance.url}>
                <span>source</span>
                <strong>{source?.title || object.provenance.pageTitle}</strong>
              </div>
            </article>
          );
        })}

        {debugDom && rawCards.slice(0, 160).map(card => {
          const source = sourceMap.get(card.sourceId);
          return (
            <article
              key={`${card.sourceId}-${card.id}`}
              className="semanticCard rawCard"
              style={{ left: card.x, top: card.y }}
              onPointerDown={event => pointerDown(event, `${card.sourceId}-${card.id}`, card.x, card.y, 'raw')}
            >
              <div className="cardMeta"><span>{card.role}</span><code>{source ? kindLabel(source.kind) : card.id}</code></div>
              <div className="cardText">{card.text || `<${card.tag}>`}</div>
              {card.href && <div className="cardHref">{card.href}</div>}
              <div className="cardBox">{card.bbox.join(' · ')}</div>
            </article>
          );
        })}

        {!objects.length && !rawCards.length && (
          <div className="empty">
            <div className="emptyIcon">◎</div>
            <h1>Compose the internet.</h1>
            <p>Add Gmail, Drive, Google results, ordinary web pages and local images. Each source becomes movable widgets instead of another rectangular application window.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
