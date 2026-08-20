import fs from 'node:fs';

const appPath = 'apps/web/src/SpatialApp.tsx';
const cssPath = 'apps/web/src/spatial.css';
let app = fs.readFileSync(appPath, 'utf8').replace(/\r\n/g, '\n');
let css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(from, to, label) {
  if (!app.includes(from)) throw new Error(`Missing anchor: ${label}`);
  app = app.replace(from, to);
}

replaceOnce(
`type WorkspaceSource = {\n  id:string; providerId?:BrowserProviderId; targetId?:string; providerLabel?:string;\n  title:string; url:string; kind:SourceKind; updatedAt:number;\n};`,
`type WorkspaceSource = {\n  id:string; providerId?:BrowserProviderId; targetId?:string; providerLabel?:string;\n  title:string; url:string; kind:SourceKind; updatedAt:number; version:number;\n};\ntype PresenceTone = 'live'|'local'|'off';\ntype PresenceItem = { label:string; state:string; tone:PresenceTone };`,
'WorkspaceSource type'
);

replaceOnce(
`function iconFor(kind:SourceKind){ if(kind==='gmail')return '✉'; if(kind==='gdrive')return '◇'; if(kind==='google-search')return '⌕'; if(kind==='local-image')return '▣'; return '◎'; }`,
`function iconFor(kind:SourceKind){ if(kind==='gmail')return '✉'; if(kind==='gdrive')return '◇'; if(kind==='google-search')return '⌕'; if(kind==='local-image')return '▣'; return '◎'; }\nfunction presenceFor(source:WorkspaceSource):PresenceItem[]{\n  if(source.kind==='local-image')return [{label:'Local',state:'SESSION',tone:'local'},{label:'Cloud',state:'NOT STORED',tone:'off'}];\n  const result:PresenceItem[]=[{label:'Web',state:'LIVE',tone:'live'},{label:'Local',state:'SESSION',tone:'local'}];\n  result.push(source.providerId==='cloud-browser-use'?{label:'Cloud',state:'RUNTIME',tone:'live'}:{label:'Cloud',state:'NOT STORED',tone:'off'});\n  return result;\n}\nfunction capabilitiesFor(source:WorkspaceSource,objects:SemanticObject[]):string[]{\n  const caps=['semantic','snapshot','spatial'];\n  if(source.kind!=='local-image')caps.push('live-source','observable');\n  if(objects.some(o=>o.actions.length))caps.push('actions');\n  if(source.providerId==='chrome-personal')caps.push('authenticated');\n  if(source.providerId==='cloud-browser-use')caps.push('cloud-runtime');\n  if(source.kind==='local-image')caps.push('local-source');\n  return caps;\n}\nfunction ObjectMetaHover({source,objects}:{source:WorkspaceSource;objects:SemanticObject[]}){\n  const presence=presenceFor(source);\n  const caps=capabilitiesFor(source,objects);\n  return <div className=\"objectMetaHover\">\n    <div className=\"presenceRow\">{presence.map(item=><span key={item.label} className={\`presenceChip \${item.tone}\`}><i/>{item.label}<b>{item.state}</b></span>)}</div>\n    <div className=\"capabilityRow\"><strong>v{source.version}</strong>{caps.map(cap=><span key={cap}>{cap}</span>)}</div>\n  </div>;\n}`,
'helpers'
);

replaceOnce(
`      <div className=\"minimalCaption\"><strong>{primary.title||source.title}</strong><span>{itemCount?\`\${itemCount} items\`:primary.label}</span></div>\n    </div>;`,
`      <div className=\"minimalCaption\"><strong>{primary.title||source.title}</strong><span>{itemCount?\`\${itemCount} items\`:primary.label}</span></div>\n      <ObjectMetaHover source={source} objects={objects}/>\n    </div>;`,
'minimal meta'
);

replaceOnce(
`    <div className=\"editorialGrid\">`,
`    <ObjectMetaHover source={source} objects={objects}/>\n    <div className=\"editorialGrid\">`,
'composition meta'
);

replaceOnce(
`      const next:WorkspaceSource={id:sourceId,providerId,targetId,providerLabel:providerLabel||providerShortLabel(providerId),title:data.snapshot.title||data.snapshot.url,url:data.snapshot.url,kind:data.sourceKind,updatedAt:Date.now()};\n      const index=prev.findIndex(s=>s.id===sourceId);`,
`      const index=prev.findIndex(s=>s.id===sourceId);\n      const previous=index>=0?prev[index]:undefined;\n      const next:WorkspaceSource={id:sourceId,providerId,targetId,providerLabel:providerLabel||providerShortLabel(providerId),title:data.snapshot.title||data.snapshot.url,url:data.snapshot.url,kind:data.sourceKind,updatedAt:Date.now(),version:(previous?.version||0)+1};`,
'upsert version'
);

replaceOnce(
`const source:WorkspaceSource={id,title:file.name,url:\`local-file://\${file.name}\`,kind:'local-image',updatedAt:Date.now()};`,
`const source:WorkspaceSource={id,title:file.name,url:\`local-file://\${file.name}\`,kind:'local-image',updatedAt:Date.now(),version:1};`,
'local image version'
);

replaceOnce(
`<div className=\"spreadStats\"><span><b>{objects.length}</b> regions</span><span><b>{itemCount}</b> items</span><span>{primary.representation||'data'}</span></div>`,
`<div className=\"spreadStats\"><span><b>{objects.length}</b> regions</span><span><b>{itemCount}</b> items</span><span>{primary.representation||'data'}</span><span>v{source.version}</span></div>`,
'footer version'
);

const cssAddon = `\n/* Semantic object presence / capabilities -------------------------------- */\n.objectMetaHover{position:absolute;z-index:18;left:14px;top:54px;display:grid;gap:5px;max-width:calc(100% - 28px);padding:7px 9px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(11,14,18,.88);backdrop-filter:blur(16px);box-shadow:0 10px 28px rgba(0,0,0,.2);opacity:0;transform:translateY(-4px);transition:opacity .16s ease,transform .16s ease;pointer-events:none;color:#dce3ea}.spreadInner:hover>.objectMetaHover{opacity:1;transform:translateY(0)}.minimalInner>.objectMetaHover{top:50px}.presenceRow,.capabilityRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.presenceChip{display:inline-flex;align-items:center;gap:4px;font-size:7px;letter-spacing:.04em;text-transform:uppercase;color:#9ca7b4}.presenceChip i{width:6px;height:6px;border-radius:50%;background:#56616f}.presenceChip b{font-size:6px;font-weight:800;color:#697482}.presenceChip.live i{background:#65d6ae;box-shadow:0 0 8px rgba(101,214,174,.45)}.presenceChip.live b{color:#79dfbd}.presenceChip.local i{background:#8aa8d8}.presenceChip.local b{color:#a7bee1}.presenceChip.off{opacity:.55}.capabilityRow{padding-top:4px;border-top:1px solid rgba(255,255,255,.08)}.capabilityRow strong{font-size:7px;color:#f0c28e}.capabilityRow span{font-size:6px;color:#7f8b98;text-transform:uppercase;letter-spacing:.06em}.spread-composition:hover,.spread-minimal:hover{z-index:8;filter:drop-shadow(0 26px 48px rgba(0,0,0,.34))}\n`;
if (!css.includes('.objectMetaHover{')) css += cssAddon;

fs.writeFileSync(appPath, app);
fs.writeFileSync(cssPath, css);
console.log('OBJECT_PRESENCE_UI_PATCHED');
