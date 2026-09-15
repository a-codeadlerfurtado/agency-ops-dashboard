from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1')
s=p.read_text(encoding='utf-8-sig')
s=s.replace("foreach($name in @('reader-ia','reader-ia-translate','reader-ia-tts')){","foreach($name in @('reader-ia')){")
s=s.replace("Invoke-DockerJson \"$base/services/create\" 'Post' $translator | Out-Null\nWrite-Output 'translator_created'","$translatorExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-translate'} | Select-Object -First 1\nif(-not $translatorExisting){ Invoke-DockerJson \"$base/services/create\" 'Post' $translator | Out-Null; Write-Output 'translator_created' } else { Write-Output 'translator_reused' }")
s=s.replace("Invoke-DockerJson \"$base/services/create\" 'Post' $tts | Out-Null\nWrite-Output 'tts_created'","$ttsExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-tts'} | Select-Object -First 1\nif(-not $ttsExisting){ Invoke-DockerJson \"$base/services/create\" 'Post' $tts | Out-Null; Write-Output 'tts_created' } else { Write-Output 'tts_reused' }")
p.write_text(s,encoding='utf-8-sig')
print('persistent translator/tts deploy enabled')