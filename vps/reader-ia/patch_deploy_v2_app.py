from pathlib import Path
p=Path('deploy-reader.ps1');s=p.read_text(encoding='utf-8-sig')
old="$indexCfg=New-DockerConfig \"reader-ia-index-$stamp\" (Join-Path $dir 'index.html')\nWrite-Output 'configs_created'"
new="$indexCfg=New-DockerConfig \"reader-ia-index-$stamp\" (Join-Path $dir 'index.html')\n$appCfg=New-DockerConfig \"reader-ia-app-v2-$stamp\" (Join-Path $dir 'app-v2.mjs')\nWrite-Output 'configs_created'"
if old not in s: raise SystemExit('config creation anchor missing')
s=s.replace(old,new,1)
old2='''        @{ConfigID=$serverCfg.ID;ConfigName="reader-ia-server-$stamp";File=@{Name='/app/server.py';UID='0';GID='0';Mode=292}},\n        @{ConfigID=$indexCfg.ID;ConfigName="reader-ia-index-$stamp";File=@{Name='/app/index.html';UID='0';GID='0';Mode=292}}\n'''
new2='''        @{ConfigID=$serverCfg.ID;ConfigName="reader-ia-server-$stamp";File=@{Name='/app/server.py';UID='0';GID='0';Mode=292}},\n        @{ConfigID=$indexCfg.ID;ConfigName="reader-ia-index-$stamp";File=@{Name='/app/index.html';UID='0';GID='0';Mode=292}},\n        @{ConfigID=$appCfg.ID;ConfigName="reader-ia-app-v2-$stamp";File=@{Name='/app/app-v2.mjs';UID='0';GID='0';Mode=292}}\n'''
if old2 not in s: raise SystemExit('reader configs block missing')
s=s.replace(old2,new2,1);p.write_text(s,encoding='utf-8-sig')
print('deploy app-v2 config patched')
