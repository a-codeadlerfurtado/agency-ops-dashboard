import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { pool, withTenantTx } from './db.js';
import { assertSafeRemoteUrl, getPath, secretHeaders } from './integration-utils.js';

type XmlIntegration = { id:string; tenant_id:string; config:any; secret_enc:Buffer|null };

function text(v:any){
  if(v==null) return null;
  if(typeof v==='object') return v['#text'] ?? v['@_value'] ?? null;
  const s=String(v).trim(); return s || null;
}
function num(v:any){
  const s=text(v); if(!s) return null;
  let cleaned=s.replace(/[^0-9,.-]/g,'');
  const comma=cleaned.lastIndexOf(',');
  const dot=cleaned.lastIndexOf('.');
  if(comma>=0 && dot>=0){
    const decimal=comma>dot?',':'.';
    const thousand=decimal===','?'.':',';
    cleaned=cleaned.split(thousand).join('').replace(decimal,'.');
  } else if(comma>=0) {
    const parts=cleaned.split(',');
    cleaned=parts.length===2 && parts[1].length<=2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else if(dot>=0) {
    const parts=cleaned.split('.');
    if(parts.length>2 || (parts.length===2 && parts[1].length===3)) cleaned=parts.join('');
  }
  const n=Number(cleaned);
  return Number.isFinite(n)?n:null;
}
function integer(v:any){const n=num(v);return n==null?null:Math.round(n);}
function op(v:any){
  const s=(text(v)||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(/ALUG|LOCAC|RENT/.test(s)) return 'LOCACAO';
  if(/VENDA|SALE|COMPRA/.test(s)) return 'VENDA';
  if(/AMBOS|BOTH/.test(s)) return 'AMBOS';
  return 'VENDA';
}
function status(v:any){
  const s=(text(v)||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(/VEND/.test(s)) return 'VENDIDO'; if(/ALUGAD/.test(s)) return 'ALUGADO';
  if(/RESERV/.test(s)) return 'RESERVADO'; if(/SUSP|INATIV|OFF/.test(s)) return 'SUSPENSO';
  return 'DISPONIVEL';
}
function urls(v:any, out:string[]=[]):string[]{
  if(v==null) return out;
  if(Array.isArray(v)){for(const x of v) urls(x,out);return out;}
  if(typeof v==='string' && /^https?:\/\//i.test(v.trim())){out.push(v.trim());return out;}
  if(typeof v==='object'){
    for(const [k,x] of Object.entries(v)){
      if(/url|src|link/i.test(k) && typeof x==='string' && /^https?:\/\//i.test(x)) out.push(x);
      else urls(x,out);
    }
  }
  return out;
}
function itemArray(doc:any, path?:string){
  const explicit=getPath(doc,path||null);
  if(Array.isArray(explicit)) return explicit;
  if(explicit && typeof explicit==='object') return [explicit];
  const keys=['Listing','Property','Imovel','ImovelWeb'];
  const walk=(x:any):any[]|null=>{
    if(!x||typeof x!=='object') return null;
    for(const [k,v] of Object.entries(x)){
      if(keys.includes(k.split(':').pop()||'') && Array.isArray(v)) return v;
      const found=walk(v); if(found) return found;
    }
    return null;
  };
  return walk(doc)||[];
}

function mapped(rec:any, mapping:any, key:string, fallback:string[]){
  return getPath(rec,mapping?.[key] ?? fallback);
}
function normalizeRecord(rec:any,m:any){
  const code=text(mapped(rec,m,'code',['ListingID','PropertyID','Codigo','CodigoImovel','ID','Id']));
  if(!code) return null;
  const operation=op(mapped(rec,m,'operation',['TransactionType','TipoOperacao','Operacao']));
  const normalized={
    code,operation,type:text(mapped(rec,m,'type',['Details.PropertyType','PropertyType','TipoImovel','Tipo']))||'Imóvel',
    status:status(mapped(rec,m,'status',['Status','Situacao'])),price:num(mapped(rec,m,'price',['ListPrice','Price','PrecoVenda','Preco'])),
    rentPrice:num(mapped(rec,m,'rentPrice',['RentalPrice','PrecoLocacao','ValorAluguel'])),condo:num(mapped(rec,m,'condo',['PropertyAdministrationFee','CondominiumFee','ValorCondominio','Condominio'])),
    iptu:num(mapped(rec,m,'iptu',['YearlyTax','IPTU','ValorIPTU'])),bedrooms:integer(mapped(rec,m,'bedrooms',['Details.Bedrooms','Bedrooms','Quartos'])),
    suites:integer(mapped(rec,m,'suites',['Details.Suites','Suites'])),bathrooms:integer(mapped(rec,m,'bathrooms',['Details.Bathrooms','Bathrooms','Banheiros'])),
    parking:integer(mapped(rec,m,'parking',['Details.Garage','Garage','ParkingSpaces','Vagas'])),usefulArea:num(mapped(rec,m,'usefulArea',['Details.LivingArea','LivingArea','AreaUtil'])),
    totalArea:num(mapped(rec,m,'totalArea',['Details.LotArea','LotArea','AreaTotal'])),neighborhood:text(mapped(rec,m,'neighborhood',['Location.Neighborhood','Neighborhood','Bairro'])),
    city:text(mapped(rec,m,'city',['Location.City','City','Cidade'])),state:text(mapped(rec,m,'state',['Location.State','State','UF'])),zip:text(mapped(rec,m,'zip',['Location.PostalCode','PostalCode','CEP'])),
    address:text(mapped(rec,m,'address',['Location.Address','Address','Logradouro'])),title:text(mapped(rec,m,'title',['Title','Titulo'])),description:text(mapped(rec,m,'description',['Details.Description','Description','Descricao'])),
    url:text(mapped(rec,m,'url',['DetailViewUrl','URL','UrlAnuncio'])),photos:urls(mapped(rec,m,'photos',['Media','Photos','Fotos'])).slice(0,80)
  };
  const hash=crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return {...normalized,hash};
}
export async function syncXmlIntegration(integration:XmlIntegration){
  const cfg=integration.config||{};
  const url=await assertSafeRemoteUrl(String(cfg.url||''),Boolean(cfg.allowHttp));
  const res=await fetch(url,{headers:{...secretHeaders(integration.secret_enc),'accept':'application/xml,text/xml;q=0.9,*/*;q=0.1'}});
  if(!res.ok) throw new Error(`xml_http_${res.status}`);
  const xml=await res.text();
  if(xml.length<20) throw new Error('xml_empty');
  const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',trimValues:true,parseTagValue:false});
  const doc=parser.parse(xml);
  const records=itemArray(doc,cfg.itemPath);
  if(!records.length) throw new Error('xml_no_records');
  const normalized=records.map((r:any)=>normalizeRecord(r,cfg.mapping)).filter(Boolean) as any[];
  if(!normalized.length) throw new Error('xml_no_valid_records');
  const source=`XML:${integration.id}`;
  await withTenantTx({tenantId:integration.tenant_id},async(db)=>{
    for(const p of normalized){
      await db.query(`INSERT INTO properties
        (tenant_id,codigo_externo,operacao,tipo,status,preco,preco_locacao,condominio,iptu,quartos,suites,banheiros,vagas,area_util,area_total,bairro,cidade,uf,cep,logradouro,titulo,descricao,fotos,url_anuncio,content_hash,fonte,sincronizado_em)
        VALUES($1,$2,$3::operacao,$4,$5::property_status,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26,now())
        ON CONFLICT(tenant_id,codigo_externo) DO UPDATE SET operacao=EXCLUDED.operacao,tipo=EXCLUDED.tipo,status=EXCLUDED.status,
        preco=EXCLUDED.preco,preco_locacao=EXCLUDED.preco_locacao,condominio=EXCLUDED.condominio,iptu=EXCLUDED.iptu,quartos=EXCLUDED.quartos,suites=EXCLUDED.suites,
        banheiros=EXCLUDED.banheiros,vagas=EXCLUDED.vagas,area_util=EXCLUDED.area_util,area_total=EXCLUDED.area_total,bairro=EXCLUDED.bairro,cidade=EXCLUDED.cidade,
        uf=EXCLUDED.uf,cep=EXCLUDED.cep,logradouro=EXCLUDED.logradouro,titulo=EXCLUDED.titulo,descricao=EXCLUDED.descricao,fotos=EXCLUDED.fotos,url_anuncio=EXCLUDED.url_anuncio,
        content_hash=EXCLUDED.content_hash,fonte=EXCLUDED.fonte,sincronizado_em=now(),updated_at=CASE WHEN properties.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE properties.updated_at END`,
        [integration.tenant_id,p.code,p.operation,p.type,p.status,p.price,p.rentPrice,p.condo,p.iptu,p.bedrooms,p.suites,p.bathrooms,p.parking,p.usefulArea,p.totalArea,p.neighborhood,p.city,p.state,p.zip,p.address,p.title,p.description,JSON.stringify(p.photos),p.url,p.hash,source]);
    }
    const codes=normalized.map((p)=>p.code);
    await db.query(`UPDATE properties SET status='SUSPENSO',updated_at=now()
      WHERE tenant_id=$1 AND fonte=$2 AND codigo_externo<>ALL($3::text[]) AND status='DISPONIVEL'`,
      [integration.tenant_id,source,codes]);
    const interval=Math.max(15,Math.min(10080,Number(cfg.intervalMinutes)||1440));
    await db.query(`UPDATE integrations SET ultimo_sync=now(),ultimo_erro=NULL,claimed_at=NULL,
      next_sync_at=now()+($3::text||' minutes')::interval WHERE tenant_id=$1 AND id=$2`,
      [integration.tenant_id,integration.id,String(interval)]);
    await db.query(`INSERT INTO events(tenant_id,tipo,payload) VALUES($1,'XML_SYNC',$2::jsonb)`,
      [integration.tenant_id,JSON.stringify({integrationId:integration.id,total:normalized.length})]);
  });
  return {total:normalized.length};
}

async function failXml(integration:XmlIntegration,error:string){
  await withTenantTx({tenantId:integration.tenant_id},async(db)=>{
    await db.query(`UPDATE integrations SET ultimo_erro=$3,claimed_at=NULL,next_sync_at=now()+interval '15 minutes'
      WHERE tenant_id=$1 AND id=$2`,[integration.tenant_id,integration.id,error.slice(0,1800)]);
  });
}

let running=false;
export function startXmlSyncLoop(){
  const tick=async()=>{
    if(running)return; running=true;
    try{
      const tenants=await pool.query(`SELECT id FROM tenants WHERE ativo=true ORDER BY created_at`);
      for(const tenant of tenants.rows){
        const due=await withTenantTx({tenantId:tenant.id},async(db)=>(await db.query(`UPDATE integrations i SET claimed_at=now()
          WHERE i.id IN (SELECT id FROM integrations WHERE tenant_id=$1 AND tipo='XML' AND ativo=true
          AND COALESCE(next_sync_at,now())<=now() AND (claimed_at IS NULL OR claimed_at<now()-interval '30 minutes')
          ORDER BY COALESCE(next_sync_at,now()) LIMIT 3 FOR UPDATE SKIP LOCKED)
          RETURNING i.id,i.tenant_id,i.config,i.secret_enc`,[tenant.id])).rows as XmlIntegration[]);
        for(const integration of due){try{await syncXmlIntegration(integration);}catch(e){await failXml(integration,e instanceof Error?e.message:String(e));}}
      }
    }finally{running=false;}
  };
  void tick(); setInterval(()=>{void tick();},300000).unref();
}
