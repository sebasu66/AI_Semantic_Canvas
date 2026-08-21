import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

type RawElement = { id:string; sourceIndex:number; tag:string; role:string; text:string; href?:string|null; bbox:number[] };
type Snapshot = { title:string; url:string; viewport:{width:number;height:number}; elements:RawElement[] };
type SourceKind = 'web'|'gmail'|'gdrive'|'google-search'|'local-image';
type BrowserProviderId = 'chrome-personal'|'edge-worker'|'cloud-browser-use';
type ProviderChoice = 'auto'|BrowserProviderId;
type BrowserProviderStatus = { id:BrowserProviderId; label:string; configured:boolean; connected:boolean; targetCount:number; detail?:string };
type BrowserTarget = { providerId:BrowserProviderId; targetId:string; title:string; url:string; browserLabel:string };
type SemanticAction = { id:string; kind:'navigate'|'click'; label:string; href?:string; selector?:string; itemIndex?:number; sourceIndex?:number };
type SemanticObject = {
  id:string;
  type:string;
  label:string;
  representation?:'data'|'live-region'|'hybrid';
  regionSelector?:string;
  title?:string;
  description?:string;
  text?:string;
  items?:string[];
  imageUrl?:string;
  actions:SemanticAction[];
  provenance:{ url:string; pageTitle:string; elementIds:string[]; boxes:number[][] };
};
type WorkspaceSource = {
  id:string; providerId?:BrowserProviderId; targetId?:string; providerLabel?:string;
  title:string; url:string; kind:SourceKind; updatedAt:number; version:number;
};
type PresenceTone = 'live'|'local'|'off';
type PresenceItem = { label:string; state:string; tone:PresenceTone };
type SnapshotResponse = { ok:true; snapshot:Snapshot; semanticObjects:SemanticObject[]; sourceKind:Exclude<SourceKind,'local-image'>; recipe?:{status:string;recipeId?:string;score?:number} };
type OpenResponse = SnapshotResponse & { target:BrowserTarget };
type ActionResponse = SnapshotResponse & { targetId:string };
type ProvidersResponse = { ok:true; providers:BrowserProviderStatus[] };
type SpreadMode = 'minimal'|'composition'|'docked';
type SpreadState = { x:number; y:number; mode:SpreadMode; pinned?:boolean };

type StoredLayout = { spreads:Record<string,SpreadState>; world:{scrollLeft:number;scrollTop:number} };

const WORLD_W = 7200;
const WORLD_H = 4600;
const LAYOUT_KEY = 'asc-spatial-layout-v2';

async function api<T>(url:string, options?:RequestInit):Promise<T>{
  const response = await fetch(url,{headers:{'Content-Type':'application/json'},...options});
  const data = await response.json();
  if(!response.ok || data.ok===false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function normalizeUrl(value:string){ const v=value.trim(); if(!v)return 'https://example.com'; return /^https?:\/\//i.test(v)?v:`https://${v}`; }
function providerShortLabel(id?:BrowserProviderId){ if(id==='chrome-personal')return 'Personal'; if(id==='edge-worker')return 'Worker'; if(id==='cloud-browser-use')return 'Cloud'; return 'Local'; }
function kindLabel(kind:SourceKind){ if(kind==='gmail')return 'Gmail'; if(kind==='gdrive')return 'Drive'; if(kind==='google-search')return 'Search'; if(kind==='local-image')return 'Image'; return 'Web'; }
function autoProviderFor(urlValue:string):BrowserProviderId{ try{const host=new URL(urlValue).hostname.toLowerCase();if(host==='mail.google.com'||host==='drive.google.com')return 'chrome-personal';}catch{} return 'edge-worker'; }
function iconFor(kind:SourceKind){ if(kind==='gmail')return '✉'; if(kind==='gdrive')return '◇'; if(kind==='google-search')return '⌕'; if(kind==='local-image')return '▣'; return '◎'; }
function presenceFor(source:WorkspaceSource):PresenceItem[]{
  if(source.kind==='local-image')return [{label:'Local',state:'SESSION',tone:'local'},{label:'Cloud',state:'NOT STORED',tone:'off'}];
  const result:PresenceItem[]=[{label:'Web',state:'LIVE',tone:'live'},{label:'Local',state:'SESSION',tone:'local'}];
  result.push(source.providerId==='cloud-browser-use'?{label:'Cloud',state:'RUNTIME',tone:'live'}:{label:'Cloud',state:'NOT STORED',tone:'off'});
  return result;
}
function capabilitiesFor(source:WorkspaceSource,objects:SemanticObject[]):string[]{
  const caps=['semantic','snapshot','spatial'];
  if(source.kind!=='local-image')caps.push('live-source','observable');
  if(objects.some(o=>o.actions.length))caps.push('actions');
  if(source.providerId==='chrome-personal')caps.push('authenticated');
  if(source.providerId==='cloud-browser-use')caps.push('cloud-runtime');
  if(source.kind==='local-image')caps.push('local-source');
  return caps;
}
function ObjectMetaHover({source,objects}:{source:WorkspaceSource;objects:SemanticObject[]}){
  const presence=presenceFor(source);
  const caps=capabilitiesFor(source,objects);
  return <div className="objectMetaHover">
    <div className="presenceRow">{presence.map(item=><span key={item.label} className={`presenceChip ${item.tone}`}><i/>{item.label}<b>{item.state}</b></span>)}</div>
    <div className="capabilityRow"><strong>v{source.version}</strong>{caps.map(cap=><span key={cap}>{cap}</span>)}</div>
  </div>;
}

function loadLayout():StoredLayout{
  try{ const raw=localStorage.getItem(LAYOUT_KEY); if(raw)return JSON.parse(raw) as StoredLayout; }catch{}
  return {spreads:{},world:{scrollLeft:0,scrollTop:0}};
}

function useHtmlCanvasSupport(){
  const [supported,setSupported]=useState(false);
  useEffect(()=>{
    const ctx=(window as any).CanvasRenderingContext2D?.prototype;
    const canvas=(window as any).HTMLCanvasElement?.prototype;
    setSupported(Boolean(ctx?.drawElementImage && canvas?.requestPaint));
  },[]);
  return supported;
}

function HtmlCanvasFrame({children,className}:{children:ReactNode;className:string}){
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const contentRef=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{
    const canvas=canvasRef.current as any;
    const content=contentRef.current;
    if(!canvas||!content)return;
    const ctx=canvas.getContext('2d') as any;
    if(!ctx?.drawElementImage)return;
    const paint=()=>{
      const rect=canvas.getBoundingClientRect();
      const dpr=window.devicePixelRatio||1;
      const w=Math.max(1,Math.round(rect.width*dpr));
      const h=Math.max(1,Math.round(rect.height*dpr));
      if(canvas.width!==w)canvas.width=w;
      if(canvas.height!==h)canvas.height=h;
      try{
        ctx.reset?.();
        ctx.setTransform(dpr,0,0,dpr,0,0);
        const transform=ctx.drawElementImage(content,0,0,rect.width,rect.height);
        if(transform)content.style.transform=transform.toString();
      }catch{}
    };
    canvas.onpaint=paint;
    const ro=new ResizeObserver(()=>canvas.requestPaint?.());
    ro.observe(canvas);
    const mo=new MutationObserver(()=>canvas.requestPaint?.());
    mo.observe(content,{subtree:true,childList:true,characterData:true,attributes:true});
    requestAnimationFrame(()=>canvas.requestPaint?.());
    return()=>{ro.disconnect();mo.disconnect();canvas.onpaint=null;};
  },[children]);
  return <canvas ref={canvasRef} className={`htmlCanvasFrame ${className}`} {...({layoutsubtree:'true'} as any)}><div ref={contentRef} className="htmlCanvasContent">{children}</div></canvas>;
}

function SpreadFrame({children,className,useHtmlCanvas}:{children:ReactNode;className:string;useHtmlCanvas:boolean}){
  return useHtmlCanvas?<HtmlCanvasFrame className={className}>{children}</HtmlCanvasFrame>:<div className={className}>{children}</div>;
}

function rankObject(object:SemanticObject){
  if(object.type==='video'||object.representation==='live-region')return 100;
  if(object.type==='image')return 95;
  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results')return 90;
  if(object.type==='document')return 75;
  if(object.type==='form')return 60;
  if(object.type==='section')return 45;
  return 30;
}

function PrimaryVisual({object,onAction,busy}:{object:SemanticObject;onAction:(a:SemanticAction)=>void;busy:boolean}){
  if(object.imageUrl) return <img className="heroImage" src={object.imageUrl} alt={object.title||object.label} draggable={false}/>;
  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results'){
    return <div className={`heroList heroList-${object.type}`}>{(object.items||[]).slice(0,14).map((item,i)=>{
      const action=object.actions[i];
      return <button className="heroListRow" key={i} disabled={busy&&!action} onClick={()=>action&&onAction(action)} title={action?.label||String(item)}>
        <span>{String(i+1).padStart(2,'0')}</span><p>{item}</p><i>{action?'›':''}</i>
      </button>;
    })}</div>;
  }
  return <div className="heroType"><strong>{object.title||object.label}</strong><p>{object.description||object.text||'Semantic source'}</p></div>;
}

function SpreadContent({source,objects,mode,busy,onAction,onMode,onFocus,onDock,onClose,onPin}:{
  source:WorkspaceSource; objects:SemanticObject[]; mode:'minimal'|'composition'|'focus'; busy:boolean;
  onAction:(a:SemanticAction)=>void; onMode:(m:SpreadMode)=>void; onFocus:()=>void; onDock:()=>void; onClose:()=>void; onPin:()=>void;
}){
  const sorted=[...objects].sort((a,b)=>rankObject(b)-rankObject(a));
  const primary=sorted[0];
  const secondary=sorted.slice(1,5);
  const itemCount=objects.reduce((sum,o)=>sum+(o.items?.length||0),0);
  if(!primary)return null;

  if(mode==='minimal'){
    return <div className={`spreadInner minimalInner kind-${source.kind}`}>
      <div className="spreadChrome compactChrome"><span>{kindLabel(source.kind)}</span><div>
        <button onClick={onMode.bind(null,'composition')} title="Composition">◫</button>
        <button onClick={onFocus} title="Focus">⛶</button><button onClick={onDock} title="Minimize">–</button>
      </div></div>
      <div className="minimalHero"><PrimaryVisual object={primary} onAction={onAction} busy={busy}/></div>
      <div className="minimalCaption"><strong>{primary.title||source.title}</strong><span>{itemCount?`${itemCount} items`:primary.label}</span></div>
      <ObjectMetaHover source={source} objects={objects}/>
    </div>;
  }

  return <div className={`spreadInner ${mode==='focus'?'focusInner':'compositionInner'} kind-${source.kind}`}>
    <header className="spreadChrome">
      <div><span className="sourceGlyph">{iconFor(source.kind)}</span><div><small>{kindLabel(source.kind)} · {providerShortLabel(source.providerId)}</small><strong>{source.title}</strong></div></div>
      <nav>
        <button onClick={onPin} title="Pin">⌖</button>
        {mode!=='focus'&&<button onClick={onMode.bind(null,'minimal')} title="Minimal">⊟</button>}
        {mode!=='focus'&&<button onClick={onFocus} title="Focus">⛶</button>}
        {mode!=='focus'&&<button onClick={onDock} title="Minimize">–</button>}
        <button onClick={onClose} title="Close">×</button>
      </nav>
    </header>

    <ObjectMetaHover source={source} objects={objects}/>
    <div className="editorialGrid">
      <section className="heroRegion">
        <div className="heroVisual"><PrimaryVisual object={primary} onAction={onAction} busy={busy}/></div>
        {!['mail-list','drive-grid','search-results'].includes(primary.type)&&<div className="heroCopy">
          <span className="eyebrow">{primary.label}</span>
          <h2>{primary.title||source.title}</h2>
          {(primary.description||primary.text)&&<p>{primary.description||primary.text}</p>}
        </div>}
      </section>

      <aside className="editorialRail">
        {secondary.length?secondary.map((object,i)=><div className={`railModule rail-${i}`} key={object.id}>
          <span>{object.label}</span><strong>{object.title||object.items?.[0]||object.text||object.type}</strong>
          {object.items?.length?<small>{object.items.length} items</small>:object.description&&<small>{object.description}</small>}
        </div>):<div className="railModule ghostModule"><span>Source</span><strong>{new URL(source.url.replace('local-file://','https://local/')).hostname||'local'}</strong></div>}
      </aside>

      <footer className="spreadFooter">
        <div className="spreadStats"><span><b>{objects.length}</b> regions</span><span><b>{itemCount}</b> items</span><span>{primary.representation||'data'}</span><span>v{source.version}</span></div>
        <div className="spreadActions">{!['mail-list','drive-grid','search-results'].includes(primary.type)&&primary.actions.slice(0,4).map(action=><button key={action.id} disabled={busy} onClick={()=>onAction(action)}>{action.label}<i>↗</i></button>)}</div>
      </footer>
    </div>
  </div>;
}

export default function SpatialApp(){
  const initialLayout=useMemo(()=>loadLayout(),[]);
  const [sources,setSources]=useState<WorkspaceSource[]>([]);
  const [sourceObjects,setSourceObjects]=useState<Record<string,SemanticObject[]>>({});
  const [providers,setProviders]=useState<BrowserProviderStatus[]>([]);
  const [providerChoice,setProviderChoice]=useState<ProviderChoice>('auto');
  const [spreads,setSpreads]=useState<Record<string,SpreadState>>(initialLayout.spreads);
  const [focusSourceId,setFocusSourceId]=useState<string|null>(null);
  const [activeSourceId,setActiveSourceId]=useState<string|null>(null);
  const [urlInput,setUrlInput]=useState('');
  const [status,setStatus]=useState('Spatial workspace ready');
  const [busy,setBusy]=useState(false);
  const [viewport,setViewport]=useState({left:initialLayout.world.scrollLeft,top:initialLayout.world.scrollTop,width:1400,height:900});
  const [debugSleep,setDebugSleep]=useState(true);
  const worldRef=useRef<HTMLDivElement|null>(null);
  const fileInput=useRef<HTMLInputElement|null>(null);
  const drag=useRef<{sourceId:string;dx:number;dy:number}|null>(null);
  const htmlCanvasSupported=useHtmlCanvasSupport();
  const sourceMap=useMemo(()=>new Map(sources.map(s=>[s.id,s])),[sources]);
  const providerMap=useMemo(()=>new Map(providers.map(p=>[p.id,p])),[providers]);
  const connectedProviders=providers.filter(p=>p.connected);
  const dockedSources=sources.filter(s=>spreads[s.id]?.mode==='docked');

  useEffect(()=>{
    let cancelled=false;
    async function poll(){try{const data=await api<ProvidersResponse>('/api/providers');if(!cancelled)setProviders(data.providers);}catch{if(!cancelled)setProviders([]);}}
    void poll();const timer=setInterval(()=>void poll(),3000);return()=>{cancelled=true;clearInterval(timer);};
  },[]);

  useEffect(()=>{
    const world=worldRef.current;if(!world)return;
    world.scrollLeft=initialLayout.world.scrollLeft;world.scrollTop=initialLayout.world.scrollTop;
  },[initialLayout]);

  useEffect(()=>{
    const data:StoredLayout={spreads,world:{scrollLeft:viewport.left,scrollTop:viewport.top}};
    try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(data));}catch{}
  },[spreads,viewport.left,viewport.top]);

  function ensureSpread(sourceId:string,ordinal:number){
    setSpreads(prev=>prev[sourceId]?prev:{...prev,[sourceId]:{x:260+(ordinal%3)*760,y:180+Math.floor(ordinal/3)*560,mode:'composition'}});
  }

  function resolveProvider(url:string,requested?:ProviderChoice):BrowserProviderId{const choice=requested??providerChoice;return choice==='auto'?autoProviderFor(url):choice;}

  function upsertSource(sourceId:string,providerId:BrowserProviderId,targetId:string,data:SnapshotResponse,isNew:boolean,providerLabel?:string){
    setSourceObjects(prev=>({...prev,[sourceId]:data.semanticObjects}));
    setSources(prev=>{
      const index=prev.findIndex(s=>s.id===sourceId);
      const previous=index>=0?prev[index]:undefined;
      const next:WorkspaceSource={id:sourceId,providerId,targetId,providerLabel:providerLabel||providerShortLabel(providerId),title:data.snapshot.title||data.snapshot.url,url:data.snapshot.url,kind:data.sourceKind,updatedAt:Date.now(),version:(previous?.version||0)+1};
      if(index<0)return[...prev,next];const copy=[...prev];copy[index]=next;return copy;
    });
    if(isNew)ensureSpread(sourceId,sources.length);
    setActiveSourceId(sourceId);
    setStatus(`${kindLabel(data.sourceKind)} · ${data.recipe?.status==='hit'?'learned recipe':'semantic extraction'} · ${data.semanticObjects.length} regions`);
  }

  async function addWebSource(urlValue:string,requested?:ProviderChoice){
    const url=normalizeUrl(urlValue);const providerId=resolveProvider(url,requested);const provider=providerMap.get(providerId);
    if(provider&&!provider.configured)throw new Error(`${provider.label} is not configured.`);
    setStatus(`Opening ${url} in background…`);
    const data=await api<OpenResponse>(`/api/providers/${providerId}/open`,{method:'POST',body:JSON.stringify({url})});
    const sourceId=`${providerId}-${data.target.targetId}`;
    upsertSource(sourceId,providerId,data.target.targetId,data,true,data.target.browserLabel);setUrlInput('');
  }

  async function submit(event?:FormEvent){event?.preventDefault();setBusy(true);try{await addWebSource(urlInput);}catch(e){setStatus(String(e));}finally{setBusy(false);}}
  async function quick(url:string){setBusy(true);try{await addWebSource(url);}catch(e){setStatus(String(e));}finally{setBusy(false);}}

  async function refresh(sourceId:string){const source=sourceMap.get(sourceId);if(!source?.providerId||!source.targetId)return;setBusy(true);try{const data=await api<SnapshotResponse>(`/api/providers/${source.providerId}/snapshot`,{method:'POST',body:JSON.stringify({targetId:source.targetId})});upsertSource(sourceId,source.providerId,source.targetId,data,false,source.providerLabel);}catch(e){setStatus(String(e));}finally{setBusy(false);}}

  async function runAction(sourceId:string,action:SemanticAction){const source=sourceMap.get(sourceId);if(!source?.providerId||!source.targetId)return;setBusy(true);try{const data=await api<ActionResponse>(`/api/providers/${source.providerId}/action`,{method:'POST',body:JSON.stringify({targetId:source.targetId,action})});upsertSource(sourceId,source.providerId,data.targetId,data,false,source.providerLabel);}catch(e){setStatus(String(e));}finally{setBusy(false);}}

  function closeSource(sourceId:string){setSources(p=>p.filter(s=>s.id!==sourceId));setSourceObjects(p=>{const n={...p};delete n[sourceId];return n;});setSpreads(p=>{const n={...p};delete n[sourceId];return n;});if(focusSourceId===sourceId)setFocusSourceId(null);setStatus('Source destroyed');}
  function setMode(sourceId:string,mode:SpreadMode){setSpreads(p=>({...p,[sourceId]:{...(p[sourceId]||{x:200,y:200}),mode}}));if(mode!=='docked')setActiveSourceId(sourceId);}
  function togglePin(sourceId:string){setSpreads(p=>({...p,[sourceId]:{...(p[sourceId]||{x:200,y:200,mode:'composition'}),pinned:!p[sourceId]?.pinned}}));}

  function addLocalImage(event:ChangeEvent<HTMLInputElement>){const file=event.target.files?.[0];event.target.value='';if(!file)return;const id=`local-image-${Date.now()}`;const imageUrl=URL.createObjectURL(file);const source:WorkspaceSource={id,title:file.name,url:`local-file://${file.name}`,kind:'local-image',updatedAt:Date.now(),version:1};const object:SemanticObject={id:'image-primary',type:'image',label:'Image',title:file.name,description:`${Math.round(file.size/1024)} KB`,imageUrl,actions:[],provenance:{url:source.url,pageTitle:file.name,elementIds:[],boxes:[]}};setSources(p=>[...p,source]);setSourceObjects(p=>({...p,[id]:[object]}));ensureSpread(id,sources.length);}

  function dragStart(event:ReactPointerEvent,sourceId:string){if((event.target as HTMLElement).closest('button'))return;const spread=spreads[sourceId];if(!spread)return;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);drag.current={sourceId,dx:event.clientX-spread.x,dy:event.clientY-spread.y};}
  function dragMove(event:ReactPointerEvent){if(!drag.current)return;const d=drag.current;setSpreads(p=>({...p,[d.sourceId]:{...p[d.sourceId],x:Math.max(40,event.clientX-d.dx),y:Math.max(100,event.clientY-d.dy)}}));}
  function dragEnd(){drag.current=null;}
  function worldScroll(){const el=worldRef.current;if(!el)return;setViewport({left:el.scrollLeft,top:el.scrollTop,width:el.clientWidth,height:el.clientHeight});}
  function sleeping(state:SpreadState){if(!debugSleep||state.pinned)return false;const margin=1200;return state.x+680<viewport.left-margin||state.x>viewport.left+viewport.width+margin||state.y+500<viewport.top-margin||state.y>viewport.top+viewport.height+margin;}

  const focusedSource=focusSourceId?sourceMap.get(focusSourceId):undefined;
  const focusedObjects=focusSourceId?sourceObjects[focusSourceId]||[]:[];

  return <div className="spatialApp" onPointerMove={dragMove} onPointerUp={dragEnd}>
    <aside className="spatialSidebar">
      <div className="spatialBrand"><span>ASC</span><div><strong>Semantic Canvas</strong><small>spatial workspace</small></div></div>
      <div className="providerStatus"><div>{connectedProviders.length}</div><p><strong>providers live</strong><span>{connectedProviders.map(p=>providerShortLabel(p.id)).join(' · ')||'offline'}</span></p></div>
      <div className="rendererBadge"><i className={htmlCanvasSupported?'live':''}/><span>{htmlCanvasSupported?'HTML-IN-CANVAS':'DOM RENDERER'}</span></div>

      <form className="spatialUrl" onSubmit={submit}>
        <div><label>ADD SOURCE</label><select value={providerChoice} onChange={e=>setProviderChoice(e.target.value as ProviderChoice)}><option value="auto">Auto</option><option value="chrome-personal">Personal</option><option value="edge-worker">Worker</option><option value="cloud-browser-use">Cloud</option></select></div>
        <section><input value={urlInput} onChange={e=>setUrlInput(e.target.value)} placeholder="URL or site"/><button disabled={busy}>+</button></section>
      </form>

      <div className="sourceShortcuts"><button onClick={()=>void quick('https://mail.google.com/mail/u/0/#inbox')}>Gmail</button><button onClick={()=>void quick('https://drive.google.com/drive/my-drive')}>Drive</button><button onClick={()=>void quick('https://www.google.com/search?q=semantic+canvas')}>Search</button><button onClick={()=>fileInput.current?.click()}>Image</button><input ref={fileInput} type="file" accept="image/*" hidden onChange={addLocalImage}/></div>

      <div className="sidebarTitle">WORLD OBJECTS · {sources.length}</div>
      <div className="worldObjects">{sources.map(source=>{
        const st=spreads[source.id];return <button key={source.id} className={activeSourceId===source.id?'active':''} onClick={()=>{setActiveSourceId(source.id);if(st?.mode==='docked')setMode(source.id,'composition');}}><span>{iconFor(source.kind)}</span><div><small>{kindLabel(source.kind)} · {st?.mode||'new'}</small><strong>{source.title}</strong></div><i>{st?.pinned?'⌖':''}</i></button>;
      })}</div>

      <div className="aiDock"><button title="AI layer">AI</button><div><strong>AI layer</strong><span>Select spatial objects to reason across them.</span></div></div>
      <div className="spatialStatus">{busy&&<i/>}{status}</div>
    </aside>

    <main className="spatialViewport" ref={worldRef} onScroll={worldScroll}>
      <div className="worldSurface" style={{width:WORLD_W,height:WORLD_H}}>
        <div className="worldLegend"><strong>INFINITE DESK</strong><span>drag · compose · focus · dock</span></div>
        {sources.map(source=>{
          const st=spreads[source.id]||{x:200,y:200,mode:'composition' as SpreadMode};
          if(st.mode==='docked')return null;
          const objs=sourceObjects[source.id]||[];
          const asleep=sleeping(st);
          if(asleep)return <button key={source.id} className="sleepingObject" style={{left:st.x,top:st.y}} onClick={()=>{worldRef.current?.scrollTo({left:Math.max(0,st.x-250),top:Math.max(0,st.y-180),behavior:'smooth'});}}><span>{iconFor(source.kind)}</span><strong>{source.title}</strong><small>sleeping</small></button>;
          const mode=st.mode==='minimal'?'minimal':'composition';
          return <div key={source.id} className={`spatialSpread spread-${mode} ${st.pinned?'pinned':''}`} style={{left:st.x,top:st.y}} onPointerDown={e=>dragStart(e,source.id)} onClick={()=>setActiveSourceId(source.id)}>
            <SpreadFrame className="spreadRenderFrame" useHtmlCanvas={htmlCanvasSupported}>
              <SpreadContent source={source} objects={objs} mode={mode} busy={busy} onAction={a=>void runAction(source.id,a)} onMode={m=>setMode(source.id,m)} onFocus={()=>setFocusSourceId(source.id)} onDock={()=>setMode(source.id,'docked')} onClose={()=>closeSource(source.id)} onPin={()=>togglePin(source.id)}/>
            </SpreadFrame>
          </div>;
        })}
      </div>
    </main>

    <div className={`shelf ${dockedSources.length?'visible':''}`}><span>SHELF</span>{dockedSources.map(source=><button key={source.id} onClick={()=>setMode(source.id,'composition')}><i>{iconFor(source.kind)}</i><strong>{source.title}</strong></button>)}</div>

    {focusedSource&&<div className="focusLayer" onClick={()=>setFocusSourceId(null)}><div className="focusAmbient"/><div className="focusStage" onClick={e=>e.stopPropagation()}><button className="focusClose" onClick={()=>setFocusSourceId(null)}>×</button><SpreadFrame className="focusRenderFrame" useHtmlCanvas={htmlCanvasSupported}><SpreadContent source={focusedSource} objects={focusedObjects} mode="focus" busy={busy} onAction={a=>void runAction(focusedSource.id,a)} onMode={()=>{}} onFocus={()=>{}} onDock={()=>{setFocusSourceId(null);setMode(focusedSource.id,'docked');}} onClose={()=>closeSource(focusedSource.id)} onPin={()=>togglePin(focusedSource.id)}/></SpreadFrame></div></div>}
  </div>;
}
