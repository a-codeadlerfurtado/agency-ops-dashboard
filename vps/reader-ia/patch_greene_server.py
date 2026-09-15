from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\server.py')
s=p.read_text(encoding='utf-8-sig')
s=s.replace('PROFILE_NAMES = ("kotler15_profile.json", "zikmund4_profile.json")','PROFILE_NAMES = ("kotler15_profile.json", "zikmund4_profile.json", "greene48_profile.json")')
s=s.replace('        line=" ".join(raw.split()).strip()\n        if not line: continue','        line=" ".join(raw.split()).strip()\n        line=re.sub(r"OceanofPDF\\.com", "", line, flags=re.I).strip()\n        if not line: continue',1)
old='''            "available":bool(fp and fp.exists()),"warmSentences":profile.get("warmSentences",4),\n            "prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[]),\n            "coverUrl": "/reader/assets/cover-kotler.jpg" if str(profile.get("id","")).startswith("kotler") else "/reader/assets/cover-zikmund.jpg"'''
new='''            "available":bool(fp and fp.exists()),"warmSentences":profile.get("warmSentences",4),\n            "prefetchPages":profile.get("prefetchPages",10),"chapters":profile.get("chapters",[]),\n            "language":profile.get("language","en"),"target":profile.get("target","pt-BR"),\n            "nativeText":bool(profile.get("nativeText",False)),"sectionMarkers":profile.get("sectionMarkers",[]),\n            "coverUrl":profile.get("coverUrl") or ("/reader/assets/cover-kotler.jpg" if str(profile.get("id","")).startswith("kotler") else "/reader/assets/cover-zikmund.jpg")'''
if old not in s: raise SystemExit('public_library marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('server profile/library patched')