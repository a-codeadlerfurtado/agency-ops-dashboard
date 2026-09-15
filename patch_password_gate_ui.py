from pathlib import Path
p=Path(r'C:\Users\Adler\agency-briefing-hub-recuperado\index.js')
s=p.read_text(encoding='utf-8')
old="""await env.DB.prepare(\"UPDATE client_portal_users SET client_id=?,email=?,display_name=?,password_hash=?,password_salt=?,password_iterations=100000,status='ACTIVE',updated_at=?,username=? WHERE id=?\").bind(cid,email,display,ph,salt,now(),username,u.id).run();"""
new="""await env.DB.prepare(\"UPDATE client_portal_users SET client_id=?,email=?,display_name=?,password_hash=?,password_salt=?,password_iterations=100000,status='ACTIVE',must_change_password=0,updated_at=?,username=? WHERE id=?\").bind(cid,email,display,ph,salt,now(),username,u.id).run();"""
assert old in s
s=s.replace(old,new,1)
old2=""".bind(uid,cid,email,display,ph,salt,100000,'ACTIVE',1,now(),now(),username).run();"""
new2=""".bind(uid,cid,email,display,ph,salt,100000,'ACTIVE',0,now(),now(),username).run();"""
assert old2 in s
s=s.replace(old2,new2,1)
anchor="""@media(max-width:900px){.auth-shell"""
css=""".login{width:min(430px,calc(100% - 32px))!important;max-width:430px!important;margin:11vh auto!important}.login>.card{background:var(--panel)!important;color:var(--text)!important;border:1px solid var(--line)!important;border-radius:18px!important;box-shadow:var(--shadow)!important;padding:24px!important}.login>.card h2{color:var(--text)!important;font:700 24px/1.15 \"Inter Tight\",Inter,sans-serif!important;margin:0 0 20px!important}.login>.card form{display:grid!important;gap:14px!important}.login>.card input{width:100%!important;background:var(--panel2)!important;color:var(--text)!important;border:1px solid var(--line)!important;border-radius:11px!important;padding:13px 14px!important;outline:0!important}.login>.card input:focus{border-color:var(--blue)!important;box-shadow:0 0 0 3px #76c6ff12!important}.login>.card .btn.primary{background:var(--accent)!important;border:1px solid var(--accent)!important;color:#1a0c02!important;border-radius:11px!important;padding:13px!important;font-weight:900!important;cursor:pointer!important}\n"""
assert anchor in s
s=s.replace(anchor,css+anchor,1)
p.write_text(s,encoding='utf-8')
print('patched gate + ui')