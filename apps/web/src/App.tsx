import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent } from 'react';

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

type Snapshot = {
  title: string;
  url: string;
  viewport: { width: number; height: number };
  elements: RawElement[];
};

type SourceKind = 'web' | 'gmail' | 'gdrive' | 'google-search' | 'local-image';
type BrowserProviderId = 'chrome-personal' | 'edge-worker' | 'cloud-browser-use';
type ProviderChoice = 'auto' | BrowserProviderId;

type BrowserProviderStatus = {
  id: BrowserProviderId;
  label: string;
  kind: string;
  configured: boolean;
  connected: boolean;
  targetCount: number;
  detail?: string;
  liveUrl?: string | null;
};

type BrowserTarget = {
  providerId: BrowserProviderId;
  targetId: string;
  title: string;
  url: string;
  browserLabel: string;
  liveUrl?: string | null;
};

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
  providerId?: BrowserProviderId;
  targetId?: string;
  providerLabel?: string;
  title: string;
  url: string;
  kind: SourceKind;
  updatedAt: number;
};

type SnapshotResponse = {
  ok: true;
  snapshot: Snapshot;
  semanticObjects: SemanticObject[];
  sourceKind: Exclude<SourceKind, 'local-image'>;
};

type OpenResponse = SnapshotResponse & { target: BrowserTarget };
type ActionResponse = SnapshotResponse & { targetId: string };

type ProvidersResponse = { ok: true; providers: BrowserProviderStatus[] };

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

function providerShortLabel(providerId?: BrowserProviderId): string {
  if (providerId === 'chrome-personal') return 'Personal';
  if (providerId === 'edge-worker') return 'Worker';
  if (providerId === 'cloud-browser-use') return 'Cloud';
  return 'Local';
}

function autoProviderFor(urlValue: string): BrowserProviderId {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    if (host === 'mail.google.com' || host === 'drive.google.com') return 'chrome-personal';
  } catch {
    // generic URLs go to the isolated worker
  }
  return 'edge-worker';
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
  const [providers, setProviders] = useState<BrowserProviderStatus[]>([]);
  const [providerChoice, setProviderChoice] = useState<ProviderChoice>('auto');
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [debugDom, setDebugDom] = useState(false);
  const [status, setStatus] = useState('Workspace ready');
  const [urlInput, setUrlInput] = useState('example.com');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number; layer: 'semantic' | 'raw' } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const sourceMap = useMemo(() => new Map(sources.map(source => [source.id, source])), [sources]);
  const providerMap = useMemo(() => new Map(providers.map(provider => [provider.id, provider])), [providers]);
  const visibleObjects = useMemo(() => objects.slice(0, 160), [objects]);
  const connectedProviders = providers.filter(provider => provider.connected);
  const cloudConfigured = providerMap.get('cloud-browser-use')?.configured ?? false;

  useEffect(() => {
    let cancelled = false;
    async function pollProviders() {
      try {
        const data = await api<ProvidersResponse>('/api/providers');
        if (!cancelled) setProviders(data.providers);
      } catch {
        if (!cancelled) setProviders([]);
      }
    }
    void pollProviders();
    const timer = window.setInterval(() => void pollProviders(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  function sourceAnchor(sourceId: string): { x: number; y: number } | undefined {
    const existing = objects.filter(object => object.sourceId === sourceId);
    if (!existing.length) return undefined;
    return {
      x: Math.min(...existing.map(object => object.x)),
      y: Math.min(...existing.map(object => object.y))
    };
  }

  function upsertSourceFromSnapshot(
    sourceId: string,
    providerId: BrowserProviderId,
    targetId: string,
    data: SnapshotResponse,
    isNew: boolean,
    providerLabel?: string
  ) {
    const ordinal = isNew ? sources.length : Math.max(0, sources.findIndex(source => source.id === sourceId));
    const anchor = isNew ? undefined : sourceAnchor(sourceId);
    const nextObjects = layoutSemantic(data.semanticObjects, sourceId, ordinal, anchor);
    const nextRaw = layoutRaw(data.snapshot.elements, sourceId, ordinal);

    setObjects(previous => [...previous.filter(object => object.sourceId !== sourceId), ...nextObjects]);
    setRawCards(previous => [...previous.filter(card => card.sourceId !== sourceId), ...nextRaw]);
    setSources(previous => {
      const nextSource: WorkspaceSource = {
        id: sourceId,
        providerId,
        targetId,
        providerLabel: providerLabel || providerMap.get(providerId)?.label || providerShortLabel(providerId),
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
    setStatus(`${kindLabel(data.sourceKind)} via ${providerShortLabel(providerId)} · ${data.semanticObjects.length} widget${data.semanticObjects.length === 1 ? '' : 's'}`);
  }

  function resolveProvider(url: string, requested?: ProviderChoice): BrowserProviderId {
    const choice = requested ?? providerChoice;
    return choice === 'auto' ? autoProviderFor(url) : choice;
  }

  async function addWebSource(urlValue: string, requestedProvider?: ProviderChoice) {
    const url = normalizeUrl(urlValue);
    const providerId = resolveProvider(url, requestedProvider);
    const provider = providerMap.get(providerId);
    if (provider && !provider.configured) {
      throw new Error(`${provider.label} is not configured yet.`);
    }

    setStatus(`Opening ${url} via ${provider?.label || providerShortLabel(providerId)}…`);
    const data = await api<OpenResponse>(`/api/providers/${providerId}/open`, {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    const sourceId = `${providerId}-${data.target.targetId}`;
    upsertSourceFromSnapshot(sourceId, providerId, data.target.targetId, data, true, data.target.browserLabel);
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
    if (!source?.providerId || !source.targetId) return;
    setBusy(true);
    setStatus(`Refreshing ${source.title}…`);
    try {
      const data = await api<SnapshotResponse>(`/api/providers/${source.providerId}/snapshot`, {
        method: 'POST',
        body: JSON.stringify({ targetId: source.targetId })
      });
      upsertSourceFromSnapshot(sourceId, source.providerId, source.targetId, data, false, source.providerLabel);
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
    if (!source?.providerId || !source.targetId) return;
    setBusy(true);
    setStatus(`${action.kind === 'navigate' ? 'Opening' : 'Executing'} ${action.label}…`);
    try {
      const data = await api<ActionResponse>(`/api/providers/${source.providerId}/action`, {
        method: 'POST',
        body: JSON.stringify({ targetId: source.targetId, action })
      });
      upsertSourceFromSnapshot(sourceId, source.providerId, data.targetId, data, false, source.providerLabel);
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

  const providerSummary = connectedProviders.length
    ? connectedProviders.map(provider => providerShortLabel(provider.id)).join(' + ')
    : 'No providers connected';

  return (
    <div className="app" onPointerMove={pointerMove} onPointerUp={pointerUp}>
      <aside className="sidebar">
        <div className="brand"><span className="orb" />AI Semantic Canvas</div>
        <p className="muted">Many sources. One fluid workspace.</p>

        <div className="connectionRow">
          <span className={connectedProviders.length ? 'connectionDot online' : 'connectionDot'} />
          <div>
            <strong>{connectedProviders.length ? `${connectedProviders.length} browser providers` : 'Browser providers offline'}</strong>
            <span>{providerSummary}</span>
          </div>
        </div>

        <div className="providerStrip">
          {providers.map(provider => (
            <span key={provider.id} className={`providerChip ${provider.connected ? 'online' : ''} ${provider.configured ? '' : 'disabled'}`} title={provider.detail}>
              <i />{providerShortLabel(provider.id)}
            </span>
          ))}
        </div>

        <form className="urlForm" onSubmit={openAndAdd}>
          <div className="formLabelRow">
            <label htmlFor="url-input">Add web source</label>
            <select value={providerChoice} onChange={event => setProviderChoice(event.target.value as ProviderChoice)} aria-label="Browser provider">
              <option value="auto">Auto</option>
              <option value="chrome-personal">Personal</option>
              <option value="edge-worker">Worker</option>
              <option value="cloud-browser-use" disabled={!cloudConfigured}>Cloud{cloudConfigured ? '' : ' · key needed'}</option>
            </select>
          </div>
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
          <span className="formHint">Auto routes authenticated sources to Personal and ordinary web to the isolated Worker.</span>
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
                <span>{kindLabel(source.kind)}{source.providerId ? ` · ${providerShortLabel(source.providerId)}` : ''}</span>
                <div>
                  {source.targetId && <button disabled={busy} title="Refresh source" onClick={event => { event.stopPropagation(); void refreshSource(source.id); }}>↻</button>}
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
            <span>{sources.length ? `${sources.length} live source${sources.length === 1 ? '' : 's'} across ${Math.max(1, connectedProviders.length)} provider${connectedProviders.length === 1 ? '' : 's'}` : 'Add sources from the left. They stay together on this canvas.'}</span>
          </div>
          <div className="headerStats">
            <button className={debugDom ? 'inspectToggle active' : 'inspectToggle'} onClick={() => setDebugDom(value => !value)}>
              {debugDom ? 'Semantic view' : 'Inspect DOM'}
            </button>
            <span className="sourceBadge">{connectedProviders.length ? `${connectedProviders.length} PROVIDERS LIVE` : 'PROVIDERS OFFLINE'}</span>
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
                <code>{source?.providerId ? `${kindLabel(source.kind)} · ${providerShortLabel(source.providerId)}` : source ? kindLabel(source.kind) : object.id}</code>
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
              <div className="cardMeta"><span>{card.role}</span><code>{source?.providerId ? providerShortLabel(source.providerId) : source ? kindLabel(source.kind) : card.id}</code></div>
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
            <p>Personal sessions, isolated worker browsers, cloud browsers and local files can become movable semantic widgets in the same workspace.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
