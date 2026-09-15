from pathlib import Path
root=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia')
p=root/'deploy-reader.ps1'
s=p.read_text(encoding='utf-8-sig')
s=s.replace('$indexCfg=New-DockerConfig "reader-ia-index-$stamp" (Join-Path $dir \'index.html\')', '$indexCfg=New-DockerConfig "reader-ia-index-$stamp" (Join-Path $dir \'index.html\')\n$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir \'kotler15_profile.json\')',1)
s=s.replace("'TRANSLATION_MODEL=translategemma:4b')", "'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')",1)
s=s.replace('@{ConfigID=$indexCfg.ID;ConfigName="reader-ia-index-$stamp";File=@{Name=\'/app/index.html\';UID=\'0\';GID=\'0\';Mode=292}}', '@{ConfigID=$indexCfg.ID;ConfigName="reader-ia-index-$stamp";File=@{Name=\'/app/index.html\';UID=\'0\';GID=\'0\';Mode=292}},\n        @{ConfigID=$profileCfg.ID;ConfigName="reader-ia-kotler-profile-$stamp";File=@{Name=\'/app/kotler15_profile.json\';UID=\'0\';GID=\'0\';Mode=292}}',1)
needle='      Configs=@(\n        @{ConfigID=$serverCfg.ID'
s=s.replace(needle,"      Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'})\n      Configs=@(\n        @{ConfigID=$serverCfg.ID",1)
out=root/'deploy-reader-preanalysis.ps1'
out.write_text(s,encoding='utf-8')
print(out)
