from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1'); s=p.read_text(encoding='utf-8-sig')
needle='$zikmundCfg=New-DockerConfig "reader-ia-zikmund-profile-$stamp" (Join-Path $dir \'zikmund4_profile.json\')'
if '$greeneCfg=' not in s:s=s.replace(needle,needle+'\n$greeneCfg=New-DockerConfig "reader-ia-greene-profile-$stamp" (Join-Path $dir \'greene48_profile.json\')',1)
needle='$coverZikmundCfg=New-DockerConfig "reader-ia-cover-zikmund-$stamp" (Join-Path $dir \'assets\\cover-zikmund.jpg\')'
if '$coverGreeneCfg=' not in s:s=s.replace(needle,needle+'\n$coverGreeneCfg=New-DockerConfig "reader-ia-cover-greene-$stamp" (Join-Path $dir \'assets\\cover-greene.jpg\')',1)
needle='@{ConfigID=$zikmundCfg.ID;ConfigName="reader-ia-zikmund-profile-$stamp";File=@{Name=\'/app/zikmund4_profile.json\';UID=\'0\';GID=\'0\';Mode=292}},'
if '$greeneCfg.ID' not in s:s=s.replace(needle,needle+'\n        @{ConfigID=$greeneCfg.ID;ConfigName="reader-ia-greene-profile-$stamp";File=@{Name=\'/app/greene48_profile.json\';UID=\'0\';GID=\'0\';Mode=292}},',1)
needle='@{ConfigID=$coverZikmundCfg.ID;ConfigName="reader-ia-cover-zikmund-$stamp";File=@{Name=\'/app/assets/cover-zikmund.jpg\';UID=\'0\';GID=\'0\';Mode=292}},'
if '$coverGreeneCfg.ID' not in s:s=s.replace(needle,needle+'\n        @{ConfigID=$coverGreeneCfg.ID;ConfigName="reader-ia-cover-greene-$stamp";File=@{Name=\'/app/assets/cover-greene.jpg\';UID=\'0\';GID=\'0\';Mode=292}},',1)
p.write_text(s,encoding='utf-8-sig'); print('deploy patched')