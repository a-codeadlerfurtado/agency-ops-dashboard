from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader-app2.ps1')
s=p.read_text(encoding='utf-8-sig')
if '$zikmundCfg=' not in s:
    s=s.replace('$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir \'kotler15_profile.json\')', '$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir \'kotler15_profile.json\')\n$zikmundCfg=New-DockerConfig "reader-ia-zikmund-profile-$stamp" (Join-Path $dir \'zikmund4_profile.json\')',1)
if "'LIBRARY_ROOT=/library'" not in s:
    s=s.replace("'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')", "'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache','LIBRARY_ROOT=/library')",1)
if "Source='readerpro-library'" not in s:
    s=s.replace("Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'})", "Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'},@{Type='volume';Source='readerpro-library';Target='/library';ReadOnly=$true})",1)
needle='@{ConfigID=$profileCfg.ID;ConfigName="reader-ia-kotler-profile-$stamp";File=@{Name=\'/app/kotler15_profile.json\';UID=\'0\';GID=\'0\';Mode=292}}'
if '$zikmundCfg.ID' not in s:
    s=s.replace(needle,needle+',\n        @{ConfigID=$zikmundCfg.ID;ConfigName="reader-ia-zikmund-profile-$stamp";File=@{Name=\'/app/zikmund4_profile.json\';UID=\'0\';GID=\'0\';Mode=292}}',1)
p.write_text(s,encoding='utf-8-sig')
print('DEPLOY_LIBRARY_PATCHED')