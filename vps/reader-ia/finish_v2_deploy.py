from pathlib import Path
p=Path('deploy-reader.ps1')
s=p.read_text(encoding='utf-8-sig')
needle="$appCfg=New-DockerConfig \"reader-ia-app-v2-$stamp\" (Join-Path $dir 'app-v2.mjs')\n"
if "$profileCfg=" not in s:
    s=s.replace(needle,needle+"$profileCfg=New-DockerConfig \"reader-ia-kotler15-profile-$stamp\" (Join-Path $dir 'kotler15_profile.json')\n",1)
s=s.replace("'TRANSLATION_MODEL=translategemma:4b')","'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')",1)
old="""        @{ConfigID=$appCfg.ID;ConfigName=\"reader-ia-app-v2-$stamp\";File=@{Name='/app/app-v2.mjs';UID='0';GID='0';Mode=292}}
      )"""
new="""        @{ConfigID=$appCfg.ID;ConfigName=\"reader-ia-app-v2-$stamp\";File=@{Name='/app/app-v2.mjs';UID='0';GID='0';Mode=292}},
        @{ConfigID=$profileCfg.ID;ConfigName=\"reader-ia-kotler15-profile-$stamp\";File=@{Name='/app/kotler15_profile.json';UID='0';GID='0';Mode=292}}
      )
      Mounts=@(@{Type='volume';Source='readerpro-cache';Target='/cache'})"""
if old not in s: raise SystemExit('reader config block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('deploy profile + persistent cache patched')