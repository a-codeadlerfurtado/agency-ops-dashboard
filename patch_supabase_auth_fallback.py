from pathlib import Path
p = Path(r"C:\Users\Adler\agency-briefing-hub-recuperado\index.js")
s = p.read_text(encoding="utf-8")
old = """if(!localOk){try{let bx=await fetch(SB+'/functions/v1/briefing-auth-bridge',{method:'POST',headers:{apikey:KEY,'content-type':'application/json','x-briefing-bridge':env.BRIEFING_SUPABASE_BRIDGE_SECRET},body:JSON.stringify({mode:'AUTH',username,password,display_name:u?.display_name||username})});if(bx.ok){sb=await bx.json();let cid=String(sb?.client_id||''),email=String(sb?.email||username+'@briefing.local').toLowerCase(),display=String(sb?.display_name||u?.display_name||username);if(!cid)throw new Error('bridge_missing_client');"""
new = """if(!localOk){try{let emailGuess=username+'@briefing.local',ax=await fetch(SB+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:KEY,'content-type':'application/json'},body:JSON.stringify({email:emailGuess,password})}),auth=await ax.json().catch(()=>({}));if(ax.ok&&auth?.access_token&&auth?.user){let meta=auth.user.user_metadata||{},cid=String(meta.briefing_client_id||''),email=String(auth.user.email||emailGuess).toLowerCase(),display=String(meta.display_name||u?.display_name||username);if(!cid)throw new Error('supabase_auth_missing_client');sb={access_token:auth.access_token,refresh_token:auth.refresh_token||null,expires_at:auth.expires_at||null,client_id:cid,user_id:auth.user.id,email,display_name:display};"""
if old not in s:
    raise SystemExit("old block not found")
s = s.replace(old, new, 1)
p.write_text(s, encoding="utf-8")
print("patched", p)
