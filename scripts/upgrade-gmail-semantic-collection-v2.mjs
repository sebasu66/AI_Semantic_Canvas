import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const bridgePath=path.join(root,'apps/bridge/src/index.ts');
const webPath=path.join(root,'apps/web/src/SpatialApp.tsx');
const cssPath=path.join(root,'apps/web/src/spatial.css');
let bridge=fs.readFileSync(bridgePath,'utf8').replace(/\r\n/g,'\n');
let web=fs.readFileSync(webPath,'utf8').replace(/\r\n/g,'\n');
let css=fs.readFileSync(cssPath,'utf8').replace(/\r\n/g,'\n');
const replaceOnce=(src,anchor,replacement,label)=>{if(!src.includes(anchor))throw new Error('Missing anchor '+label);return src.replace(anchor,replacement)};

if(!bridge.includes('type SemanticRecord = {')){
  bridge=replaceOnce(bridge,'type SemanticObject = {',`type SemanticRecord = {\n  id: string;\n  kind: 'mail';\n  title: string;\n  subtitle?: string;\n  preview?: string;\n  body?: string;\n  unread?: boolean;\n  fields: Record<string,string>;\n  sourceRef: { threadId: string; messageId: string; url: string };\n};\n\ntype SemanticObject = {`,'bridge semantic record');
  bridge=replaceOnce(bridge,'  items?: string[];\n  imageUrl?: string;','  items?: string[];\n  records?: SemanticRecord[];\n  imageUrl?: string;','bridge records field');
}
if(!bridge.includes('const gmailDetailCache = new Map')) bridge=replaceOnce(bridge,'let selectedPageIndex = 0;','let selectedPageIndex = 0;\nconst gmailDetailCache = new Map<string, SemanticRecord>();','gmail cache');

const start=bridge.indexOf('async function extractGmailProviderModel(');
const end=bridge.indexOf('\n\ntype RecipeState = {',start);
if(start<0||end<0)throw new Error('Missing Gmail extractor block');
const extractor=String.raw`async function extractGmailProviderModel(
  provider: BrowserProvider,
  targetId: string,
  snapshot: Snapshot,
): Promise<SemanticModel | null> {
  const expression = `(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = el => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    return Array.from(document.querySelectorAll('tr.zA')).filter(visible).slice(0,10).map((row,itemIndex)=>{
      const meta=row.querySelector('[data-legacy-thread-id]');
      const senderNode=row.querySelector('.yP[email],.zF[email],.yP,.zF,.bA4');
      const dateNode=row.querySelector('.xW span[title],.xW span[aria-label],.xW');
      const rect=row.getBoundingClientRect();
      return {
        itemIndex,
        threadId:meta?.getAttribute('data-legacy-thread-id')||'',
        messageId:meta?.getAttribute('data-legacy-last-message-id')||'',
        sender:clean(senderNode?.textContent),
        senderEmail:senderNode?.getAttribute?.('email')||'',
        subject:clean(row.querySelector('.bog')?.textContent||row.querySelector('.y6')?.textContent),
        snippet:clean(row.querySelector('.y2')?.textContent).replace(/^[\\s\\-\\u2013\\u2014\\u00b7]+/,''),
        date:clean(dateNode?.getAttribute?.('title')||dateNode?.getAttribute?.('aria-label')||dateNode?.textContent),
        unread:row.classList.contains('zE'),
        bbox:[Math.round(rect.x),Math.round(rect.y),Math.round(rect.width),Math.round(rect.height)]
      };
    }).filter(row=>row.threadId&&row.messageId);
  })()`;

  const rows = await provider.evaluate<Array<{itemIndex:number;threadId:string;messageId:string;sender:string;senderEmail:string;subject:string;snippet:string;date:string;unread:boolean;bbox:number[]}>>(targetId, expression);
  if(!rows?.length) return null;

  const records: SemanticRecord[] = [];
  for(const row of rows){
    const cached=gmailDetailCache.get(row.messageId);
    if(cached){records.push({...cached,unread:row.unread,preview:row.snippet||cached.preview});continue;}
    let tempTargetId='';
    try{
      const temp=await provider.open(`https://mail.google.com/mail/u/0/#inbox/${row.threadId}`);
      tempTargetId=temp.targetId;
      for(let attempt=0;attempt<35;attempt+=1){
        const ready=await provider.evaluate<number>(tempTargetId,`document.querySelectorAll('.a3s.aiL,.a3s').length`);
        if(Number(ready)>0)break;
        await new Promise(resolve=>setTimeout(resolve,180));
      }
      const detail=await provider.evaluate<{subject:string;sender:string;senderEmail:string;date:string;recipients:string;body:string}>(tempTargetId,`(() => {
        const clean=value=>String(value||'').replace(/\\s+/g,' ').trim();
        const sender=document.querySelector('.gD');
        const bodies=Array.from(document.querySelectorAll('.a3s.aiL,.a3s')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
        return {
          subject:clean(document.querySelector('h2.hP')?.textContent),
          sender:clean(sender?.textContent),
          senderEmail:sender?.getAttribute('email')||'',
          date:clean(document.querySelector('.g3')?.textContent||document.querySelector('.g3')?.getAttribute('title')),
          recipients:clean(document.querySelector('.hb')?.textContent),
          body:bodies.map(el=>String(el.innerText||'').trim()).filter(Boolean).join('\\n\\n').slice(0,16000)
        };
      })()`);
      const record:SemanticRecord={
        id:row.messageId,kind:'mail',title:detail.subject||row.subject||'(sin asunto)',
        subtitle:[detail.sender||row.sender,detail.date||row.date].filter(Boolean).join(' · '),
        preview:row.snippet,body:detail.body||row.snippet,unread:row.unread,
        fields:{sender:detail.sender||row.sender,senderEmail:detail.senderEmail||row.senderEmail,to:detail.recipients||'',date:detail.date||row.date,threadId:row.threadId,messageId:row.messageId},
        sourceRef:{threadId:row.threadId,messageId:row.messageId,url:`https://mail.google.com/mail/u/0/#inbox/${row.threadId}`}
      };
      gmailDetailCache.set(row.messageId,record);
      records.push(record);
      if(row.unread){
        try{
          const restored=await provider.evaluate<boolean>(tempTargetId,`(() => { const el=Array.from(document.querySelectorAll('[data-tooltip],[aria-label]')).find(el=>/mark as unread/i.test((el.getAttribute('data-tooltip')||'')+' '+(el.getAttribute('aria-label')||''))); if(!el)return false; el.click(); return true; })()`);
          console.log('[semantic-gmail]',JSON.stringify({stage:'restore-unread',messageId:row.messageId,restored:Boolean(restored)}));
        }catch(error){console.warn('[semantic-gmail]',JSON.stringify({stage:'restore-unread-error',messageId:row.messageId,error:String(error)}));}
      }
    }catch(error){
      console.warn('[semantic-gmail]',JSON.stringify({stage:'hydrate-error',messageId:row.messageId,error:String(error)}));
      records.push({id:row.messageId,kind:'mail',title:row.subject||'(sin asunto)',subtitle:[row.sender,row.date].filter(Boolean).join(' · '),preview:row.snippet,body:row.snippet,unread:row.unread,fields:{sender:row.sender,senderEmail:row.senderEmail,to:'',date:row.date,threadId:row.threadId,messageId:row.messageId},sourceRef:{threadId:row.threadId,messageId:row.messageId,url:`https://mail.google.com/mail/u/0/#inbox/${row.threadId}`}});
    }finally{if(tempTargetId){try{await provider.closeTarget?.(tempTargetId);}catch{}}}
  }

  console.log('[semantic-gmail]',JSON.stringify({stage:'collection',providerId:provider.id,targetId,rowCount:rows.length,recordCount:records.length,hydrated:records.filter(r=>Boolean(r.body&&r.body!==r.preview)).length}));
  const items=records.map(record=>[record.fields.sender,record.title,record.preview].filter(Boolean).join(' — '));
  return {sourceKind:'gmail',semanticObjects:[{id:'gmail-mail-collection',type:'mail-list',label:'Inbox',title:'Últimos mails',description:`${records.length} mails como objetos semánticos`,items,records,actions:[],provenance:{url:snapshot.url,pageTitle:snapshot.title,elementIds:rows.map(row=>`gmail:${row.messageId}`),boxes:rows.map(row=>row.bbox)}}]};
}`;
bridge=bridge.slice(0,start)+extractor+bridge.slice(end);

if(!web.includes('type SemanticRecord = {')){
  web=replaceOnce(web,`type SemanticAction = { id:string; kind:'navigate'|'click'; label:string; href?:string; selector?:string; itemIndex?:number; sourceIndex?:number };`,`type SemanticAction = { id:string; kind:'navigate'|'click'; label:string; href?:string; selector?:string; itemIndex?:number; sourceIndex?:number };\ntype SemanticRecord = { id:string; kind:'mail'; title:string; subtitle?:string; preview?:string; body?:string; unread?:boolean; fields:Record<string,string>; sourceRef:{threadId:string;messageId:string;url:string} };`,'web semantic record');
  web=replaceOnce(web,'  items?:string[];\n  imageUrl?:string;','  items?:string[];\n  records?:SemanticRecord[];\n  imageUrl?:string;','web records field');
}

if(!web.includes('function MailCollectionVisual(')){
  const anchor=`function PrimaryVisual({object,onAction,busy}:{object:SemanticObject;onAction:(a:SemanticAction)=>void;busy:boolean}){`;
  const component=String.raw`function MailCollectionVisual({records}:{records:SemanticRecord[]}){
  const [selectedId,setSelectedId]=useState(records[0]?.id||'');
  useEffect(()=>{if(records.length&&!records.some(r=>r.id===selectedId))setSelectedId(records[0].id);},[records,selectedId]);
  const selected=records.find(r=>r.id===selectedId)||records[0];
  if(!selected)return <div className="mailCollectionEmpty">No mail objects</div>;
  return <div className="mailCollection">
    <div className="mailRecordList">{records.map(record=><button key={record.id} className={`mailRecordButton ${record.id===selected.id?'active':''} ${record.unread?'unread':''}`} onClick={()=>setSelectedId(record.id)}>
      <span className="mailSender">{record.fields.sender||record.fields.senderEmail||'Unknown'}</span>
      <strong>{record.title}</strong>
      <small>{record.preview||record.subtitle}</small>
      <time>{record.fields.date}</time>
    </button>)}</div>
    <article className="mailRecordDetail">
      <div className="mailDetailMeta"><span>{selected.unread?'UNREAD':'MAIL OBJECT'}</span><time>{selected.fields.date}</time></div>
      <h3>{selected.title}</h3>
      <p className="mailFrom">{selected.fields.sender}{selected.fields.senderEmail?` <${selected.fields.senderEmail}>`:''}{selected.fields.to?` · ${selected.fields.to}`:''}</p>
      <div className="mailBody">{selected.body||selected.preview||'Sin cuerpo disponible.'}</div>
      <footer><code>{selected.sourceRef.messageId}</code><span>semantic mail object</span></footer>
    </article>
  </div>;
}

`+anchor;
  web=replaceOnce(web,anchor,component,'PrimaryVisual');
}
web=replaceOnce(web,`  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results'){\n    return <div className={\`heroList heroList-\${object.type}\`}>`,`  if(object.type==='mail-list'&&object.records?.length) return <MailCollectionVisual records={object.records}/>;\n  if(object.type==='mail-list'||object.type==='drive-grid'||object.type==='search-results'){\n    return <div className={\`heroList heroList-\${object.type}\`}>`,'mail primary');
web=replaceOnce(web,'  const itemCount=objects.reduce((sum,o)=>sum+(o.items?.length||0),0);','  const itemCount=objects.reduce((sum,o)=>sum+(o.records?.length||o.items?.length||0),0);\n  const collectionPrimary=Boolean(primary?.records?.length);','record count');
web=replaceOnce(web,'    <div className="editorialGrid">','    <div className={`editorialGrid ${collectionPrimary?\'collectionGrid\':\'\'}`}>','collection grid');
if(!css.includes('.mailCollection{')) css+=`\n.editorialGrid.collectionGrid{grid-template-columns:1fr}.collectionGrid .editorialRail{display:none}.mailCollection{display:grid;grid-template-columns:42% 58%;height:100%;min-height:0;background:#11151a}.mailRecordList{min-height:0;overflow:auto;border-right:1px solid rgba(255,255,255,.09);padding:7px}.mailRecordButton{position:relative;width:100%;display:grid;gap:2px;text-align:left;border:0;border-bottom:1px solid rgba(255,255,255,.07);background:transparent;color:#cfd6df;padding:9px 10px;cursor:pointer}.mailRecordButton:hover,.mailRecordButton.active{background:#1b222b}.mailRecordButton.unread:before{content:'';position:absolute;left:2px;top:13px;width:4px;height:4px;border-radius:50%;background:#82e2c1}.mailRecordButton .mailSender{font-size:8px;color:#7f8b9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mailRecordButton strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mailRecordButton small{font-size:8px;color:#7f8996;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mailRecordButton time{font-size:7px;color:#596574}.mailRecordDetail{min-width:0;min-height:0;overflow:auto;padding:18px 20px;color:#e9edf2}.mailDetailMeta{display:flex;justify-content:space-between;gap:12px;color:#738091;font-size:7px;letter-spacing:.08em}.mailRecordDetail h3{margin:8px 0 4px;font-size:18px;line-height:1.1;letter-spacing:-.02em}.mailFrom{margin:0 0 14px;color:#8d99a8;font-size:8px}.mailBody{white-space:pre-wrap;font-size:10px;line-height:1.5;color:#cbd2da;user-select:text}.mailRecordDetail footer{display:flex;justify-content:space-between;gap:10px;margin-top:18px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);font-size:7px;color:#596574}.mailRecordDetail code{font-size:7px;color:#6f7f90}.mailCollectionEmpty{padding:20px;color:#8c98a6}.minimalHero .mailCollection{grid-template-columns:1fr}.minimalHero .mailRecordDetail{display:none}\n`;
fs.writeFileSync(bridgePath,bridge,'utf8');fs.writeFileSync(webPath,web,'utf8');fs.writeFileSync(cssPath,css,'utf8');console.log('gmail semantic collection v2 applied');
