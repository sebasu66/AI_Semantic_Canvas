import fs from 'node:fs';

const bridgePath = 'apps/bridge/src/index.ts';
const appPath = 'apps/web/src/SpatialApp.tsx';
const cssPath = 'apps/web/src/spatial.css';

let bridge = fs.readFileSync(bridgePath, 'utf8').replace(/\r\n/g, '\n');
let app = fs.readFileSync(appPath, 'utf8').replace(/\r\n/g, '\n');
let css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

function replaceExact(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return text.replace(from, to);
}

// Gmail/Drive are large SPAs. The old snapshot cut the DOM at 700 candidates
// before visibility filtering, so inbox rows often never reached semantic extraction.
bridge = bridge.replaceAll(
  "const elements = candidates.slice(0, 700).map((el, sourceIndex) => {",
  "const elements = candidates.slice(0, 5000).map((el, sourceIndex) => {"
);
bridge = bridge.replaceAll(
  ").filter(element => element.visible && (element.text || ['input', 'select', 'textarea', 'button', 'a'].includes(element.tag)));",
  ").filter(element => element.visible && (element.text || ['input', 'select', 'textarea', 'button', 'a'].includes(element.tag))).slice(0, 1400);"
);
bridge = bridge.replaceAll(
  ").filter(element => element.visible && (element.text || ['input','select','textarea','button','a'].includes(element.tag)));",
  ").filter(element => element.visible && (element.text || ['input','select','textarea','button','a'].includes(element.tag))).slice(0, 1400);"
);

bridge = replaceExact(
  bridge,
`function buildGmailObjects(snapshot: Snapshot): SemanticObject[] {
  const rowCandidates = uniqueElements(snapshot.elements.filter(element =>
    (element.tag === 'tr' || element.role === 'row') &&
    element.text.length >= 8 &&
    element.text.length <= 360
  )).slice(0, 12);

  if (!rowCandidates.length) return [];
  const actions = rowCandidates
    .map(element => actionFromElement(element, element.text.slice(0, 72)))
    .filter((action): action is SemanticAction => Boolean(action));

  return [{
    id: 'gmail-inbox-visible',
    type: 'mail-list',
    label: 'Gmail',
    title: snapshot.title || 'Inbox',
    description: \`${'${rowCandidates.length}'} visible conversations\`,
    items: rowCandidates.map(element => element.text.slice(0, 150)),
    actions,
    provenance: provenance(snapshot, rowCandidates)
  }];
}`,
`function buildGmailObjects(snapshot: Snapshot): SemanticObject[] {
  const rowCandidates = uniqueElements(snapshot.elements.filter(element => {
    const [, , width = 0, height = 0] = element.bbox;
    const rowLike = element.tag === 'tr' || element.role === 'row';
    return rowLike && element.text.length >= 8 && element.text.length <= 620 && width >= 280 && height >= 18 && height <= 140;
  })).slice(0, 30);

  if (!rowCandidates.length) return [];
  const actions = rowCandidates
    .map(element => actionFromElement(element, element.text.slice(0, 96)))
    .filter((action): action is SemanticAction => Boolean(action));

  return [{
    id: 'gmail-inbox-visible',
    type: 'mail-list',
    label: 'Inbox',
    title: snapshot.title || 'Inbox',
    description: \`${'${rowCandidates.length}'} conversaciones visibles\`,
    items: rowCandidates.map(element => element.text.slice(0, 360)),
    actions,
    provenance: provenance(snapshot, rowCandidates)
  }];
}`,
  'gmail extraction'
);

const readinessAnchor = `async function snapshotProviderTarget(provider: BrowserProvider, targetId: string): Promise<Snapshot> {`;
const readinessInsert = `async function waitForSemanticContent(provider: BrowserProvider, targetId: string, urlValue: string): Promise<void> {
  const kind = sourceKindForUrl(urlValue);
  if (kind !== 'gmail' && kind !== 'gdrive') return;
  const selector = kind === 'gmail'
    ? 'tr[data-legacy-thread-id], tr.zA, [role="row"]'
    : '[role="gridcell"], [role="row"], [role="listitem"]';
  const encodedSelector = JSON.stringify(selector);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const count = await provider.evaluate<number>(targetId, \`(() => Array.from(document.querySelectorAll(\${encodedSelector})).filter(el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; }).length)()\`);
      if (Number(count) >= 3) return;
    } catch {
      // SPA readiness is best-effort; semantic snapshot still has a generic fallback.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

`;
if (!bridge.includes('async function waitForSemanticContent(')) {
  if (!bridge.includes(readinessAnchor)) throw new Error('Missing anchor: provider snapshot');
  bridge = bridge.replace(readinessAnchor, readinessInsert + readinessAnchor);
}

bridge = replaceExact(
  bridge,
`    const target = await provider.open(url);
    const snapshot = await snapshotProviderTarget(provider, target.targetId);`,
`    const target = await provider.open(url);
    await waitForSemanticContent(provider, target.targetId, url);
    const snapshot = await snapshotProviderTarget(provider, target.targetId);`,
  'provider open readiness'
);

app = replaceExact(
  app,
`function PrimaryVisual({object}:{object:SemanticObject}){
  if(object.imageUrl) return <img className="heroImage" src={object.imageUrl} alt={object.title||object.label} draggable={false}/>;
  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results'){
    return <div className="heroList">{(object.items||[]).slice(0,7).map((item,i)=><div key={i}><span>{String(i+1).padStart(2,'0')}</span><p>{item}</p></div>)}</div>;
  }
  return <div className="heroType"><strong>{object.title||object.label}</strong><p>{object.description||object.text||'Semantic source'}</p></div>;
}`,
`function PrimaryVisual({object,onAction,busy}:{object:SemanticObject;onAction:(a:SemanticAction)=>void;busy:boolean}){
  if(object.imageUrl) return <img className="heroImage" src={object.imageUrl} alt={object.title||object.label} draggable={false}/>;
  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results'){
    return <div className={\`heroList heroList-\${object.type}\`}>{(object.items||[]).slice(0,14).map((item,i)=>{
      const action=object.actions[i];
      return <button className="heroListRow" key={i} disabled={busy&&!action} onClick={()=>action&&onAction(action)} title={action?.label||String(item)}>
        <span>{String(i+1).padStart(2,'0')}</span><p>{item}</p><i>{action?'›':''}</i>
      </button>;
    })}</div>;
  }
  return <div className="heroType"><strong>{object.title||object.label}</strong><p>{object.description||object.text||'Semantic source'}</p></div>;
}`,
  'PrimaryVisual'
);

app = app.replaceAll('<PrimaryVisual object={primary}/>', '<PrimaryVisual object={primary} onAction={onAction} busy={busy}/>');

app = replaceExact(
  app,
`        <div className="heroCopy">
          <span className="eyebrow">{primary.label}</span>
          <h2>{primary.title||source.title}</h2>
          {(primary.description||primary.text)&&<p>{primary.description||primary.text}</p>}
        </div>`,
`        {!['mail-list','drive-grid','search-results'].includes(primary.type)&&<div className="heroCopy">
          <span className="eyebrow">{primary.label}</span>
          <h2>{primary.title||source.title}</h2>
          {(primary.description||primary.text)&&<p>{primary.description||primary.text}</p>}
        </div>}`,
  'hero overlay'
);

app = replaceExact(
  app,
`        <div className="spreadActions">{primary.actions.slice(0,4).map(action=><button key={action.id} disabled={busy} onClick={()=>onAction(action)}>{action.label}<i>↗</i></button>)}</div>`,
`        <div className="spreadActions">{!['mail-list','drive-grid','search-results'].includes(primary.type)&&primary.actions.slice(0,4).map(action=><button key={action.id} disabled={busy} onClick={()=>onAction(action)}>{action.label}<i>↗</i></button>)}</div>`,
  'footer actions'
);

const cssAddon = `
/* Data-first semantic surfaces ------------------------------------------------ */
.heroList{height:100%;overflow:auto;padding:0;background:#f8fafc;color:#111827}
.heroListRow{width:100%;min-height:42px;display:grid;grid-template-columns:30px minmax(0,1fr) 18px;gap:8px;align-items:center;border:0;border-bottom:1px solid #e5e7eb;background:#fff;color:#111827;padding:8px 10px;text-align:left;cursor:pointer}
.heroListRow:hover{background:#f0f7ff}.heroListRow:disabled{cursor:default;opacity:1}.heroListRow>span{font-size:8px;color:#94a3b8;font-variant-numeric:tabular-nums}.heroListRow>p{margin:0;font-size:10px;line-height:1.35;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.heroListRow>i{font-style:normal;font-size:18px;color:#64748b;text-align:center}
.kind-gmail .editorialGrid,.kind-gdrive .editorialGrid,.kind-google-search .editorialGrid{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) 56px}.kind-gmail .editorialRail,.kind-gdrive .editorialRail,.kind-google-search .editorialRail{display:none}.kind-gmail .heroRegion,.kind-gdrive .heroRegion,.kind-google-search .heroRegion{background:#fff;border:1px solid rgba(15,23,42,.08)}
.kind-gmail .spreadFooter,.kind-gdrive .spreadFooter,.kind-google-search .spreadFooter{grid-column:1;}.kind-gmail .heroVisual,.kind-gdrive .heroVisual,.kind-google-search .heroVisual{background:#fff}
`;
if (!css.includes('/* Data-first semantic surfaces')) css += cssAddon;

fs.writeFileSync(bridgePath, bridge);
fs.writeFileSync(appPath, app);
fs.writeFileSync(cssPath, css);
console.log('SEMANTIC_DATA_UI_REPAIRED');
