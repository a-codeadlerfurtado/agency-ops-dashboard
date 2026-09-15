from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1')
s=p.read_text(encoding='utf-8-sig')
anchor="$profileCfg=New-DockerConfig \"reader-ia-kotler15-profile-$stamp\" (Join-Path $dir 'kotler15_profile.json')"
extra="""$zikmundCfg=New-DockerConfig \"reader-ia-zikmund-profile-$stamp\" (Join-Path $dir 'zikmund4_profile.json')
$manifestCfg=New-DockerConfig \"reader-ia-manifest-$stamp\" (Join-Path $dir 'manifest.webmanifest')
$swCfg=New-DockerConfig \"reader-ia-sw-$stamp\" (Join-Path $dir 'sw.js')
$coverKotlerCfg=New-DockerConfig \"reader-ia-cover-kotler-$stamp\" (Join-Path $dir 'assets\\cover-kotler.jpg')
$coverZikmundCfg=New-DockerConfig \"reader-ia-cover-zikmund-$stamp\" (Join-Path $dir 'assets\\cover-zikmund.jpg')
$appleIconCfg=New-DockerConfig \"reader-ia-apple-icon-$stamp\" (Join-Path $dir 'assets\\apple-touch-icon.png')
$icon192Cfg=New-DockerConfig \"reader-ia-icon192-$stamp\" (Join-Path $dir 'assets\\icon-192.png')
$icon512Cfg=New-DockerConfig \"reader-ia-icon512-$stamp\" (Join-Path $dir 'assets\\icon-512.png')
$silenceCfg=New-DockerConfig \"reader-ia-silence-$stamp\" (Join-Path $dir 'assets\\silence.mp3')"""
if '$zikmundCfg=' not in s:s=s.replace(anchor,anchor+'\n'+extra,1)
s=s.replace("'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')","'TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache','LIBRARY_ROOT=/library')")
needle="@{ConfigID=$profileCfg.ID;ConfigName=\"reader-ia-kotler15-profile-$stamp\";File=@{Name='/app/kotler15_profile.json';UID='0';GID='0';Mode=292}}"
more="""@{ConfigID=$zikmundCfg.ID;ConfigName=\"reader-ia-zikmund-profile-$stamp\";File=@{Name='/app/zikmund4_profile.json';UID='0';GID='0';Mode=292}},
        @{ConfigID=$manifestCfg.ID;ConfigName=\"reader-ia-manifest-$stamp\";File=@{Name='/app/manifest.webmanifest';UID='0';GID='0';Mode=292}},
        @{ConfigID=$swCfg.ID;ConfigName=\"reader-ia-sw-$stamp\";File=@{Name='/app/sw.js';UID='0';GID='0';Mode=292}},
        @{ConfigID=$coverKotlerCfg.ID;ConfigName=\"reader-ia-cover-kotler-$stamp\";File=@{Name='/app/assets/cover-kotler.jpg';UID='0';GID='0';Mode=292}},
        @{ConfigID=$coverZikmundCfg.ID;ConfigName=\"reader-ia-cover-zikmund-$stamp\";File=@{Name='/app/assets/cover-zikmund.jpg';UID='0';GID='0';Mode=292}},
        @{ConfigID=$appleIconCfg.ID;ConfigName=\"reader-ia-apple-icon-$stamp\";File=@{Name='/app/assets/apple-touch-icon.png';UID='0';GID='0';Mode=292}},
        @{ConfigID=$icon192Cfg.ID;ConfigName=\"reader-ia-icon192-$stamp\";File=@{Name='/app/assets/icon-192.png';UID='0';GID='0';Mode=292}},
        @{ConfigID=$icon512Cfg.ID;ConfigName=\"reader-ia-icon512-$stamp\";File=@{Name='/app/assets/icon-512.png';UID='0';GID='0';Mode=292}},
        @{ConfigID=$silenceCfg.ID;ConfigName=\"reader-ia-silence-$stamp\";File=@{Name='/app/assets/silence.mp3';UID='0';GID='0';Mode=292}}"""
if '$zikmundCfg.ID' not in s:s=s.replace(needle,needle+',\n        '+more,1)
s=s.replace("Mounts=@(@{Type='volume';Source='readerpro-cache';Target='/cache'})","Mounts=@(@{Type='volume';Source='readerpro-cache';Target='/cache'},@{Type='volume';Source='readerpro-library';Target='/library';ReadOnly=$true})")
p.write_text(s,encoding='utf-8-sig');print('library deploy restored')