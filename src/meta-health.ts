import { pool, withTenantTx } from './db.js';
import { decryptSecret } from './crypto.js';
import { getPhone } from './meta/client.js';

type Account={id:string;phone_number_id:string;access_token_enc:Buffer;token_expires_at:string|null;token_last_error:string|null};
let running=false;

async function notify(tenantId:string,title:string,body:string){
  await withTenantTx({tenantId},async(db)=>{
    await db.query(`INSERT INTO notifications(tenant_id,tipo,titulo,corpo)
      SELECT $1,'WHATSAPP_SAUDE',$2,$3 WHERE NOT EXISTS(
        SELECT 1 FROM notifications WHERE tenant_id=$1 AND tipo='WHATSAPP_SAUDE'
          AND titulo=$2 AND created_at>now()-interval '24 hours')`,[tenantId,title,body]);
  });
}

async function verifyAccount(tenantId:string,account:Account){
  try{
    const phone=await getPhone(account.phone_number_id,decryptSecret(account.access_token_enc));
    await withTenantTx({tenantId},async(db)=>{
      await db.query(`UPDATE whatsapp_accounts SET quality_rating=COALESCE($3,quality_rating),
        token_last_verified_at=now(),token_last_error=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[tenantId,account.id,phone.quality_rating??null]);
    });    if(account.token_expires_at && new Date(account.token_expires_at).getTime()<Date.now()+7*86400000){
      await notify(tenantId,'Token WhatsApp perto de expirar',
        `O token do número ${account.phone_number_id} expira em ${new Date(account.token_expires_at).toISOString()}. Refaça o Embedded Signup antes do prazo.`);
    }
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,1200);
    await withTenantTx({tenantId},async(db)=>{
      await db.query(`UPDATE whatsapp_accounts SET token_last_verified_at=now(),token_last_error=$3,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[tenantId,account.id,message]);
    });
    if(message!==account.token_last_error){
      await notify(tenantId,'Falha no canal WhatsApp',`Número ${account.phone_number_id}: ${message}`);
    }
  }
}

async function tick(){
  if(running)return; running=true;
  try{
    const tenants=await pool.query(`SELECT id FROM tenants WHERE ativo=true ORDER BY created_at`);
    for(const tenant of tenants.rows){
      const accounts=await withTenantTx({tenantId:tenant.id},async(db)=>(await db.query(
        `SELECT id,phone_number_id,access_token_enc,token_expires_at,token_last_error FROM whatsapp_accounts
          WHERE tenant_id=$1 AND status='ATIVO' AND (token_last_verified_at IS NULL OR token_last_verified_at<now()-interval '6 hours')
          ORDER BY token_last_verified_at NULLS FIRST LIMIT 10`,[tenant.id])).rows as Account[]);
      for(const account of accounts)await verifyAccount(tenant.id,account);
    }
  }finally{running=false;}
}
export function startMetaHealthLoop(){
  void tick();
  setInterval(()=>{void tick();},60*60*1000).unref();
}
