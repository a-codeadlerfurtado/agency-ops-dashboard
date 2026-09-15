from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1')
s=p.read_text(encoding='utf-8')
needle="$reader=@{\n"
block=r'''$llm=@{
  Name='reader-ia-llm'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='ollama/ollama:latest'
      Command=@('/bin/sh','-lc','ollama serve & pid=$!; until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull qwen2.5:3b; wait $pid')
      Env=@('OLLAMA_HOST=0.0.0.0:11434','OLLAMA_KEEP_ALIVE=30m','OLLAMA_NUM_PARALLEL=1')
      Mounts=@(@{Type='volume';Source='reader-ia-ollama-data';Target='/root/.ollama'})
    }
    RestartPolicy=@{Condition='on-failure';Delay=5000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=6000000000;MemoryBytes=8589934592};Reservations=@{NanoCPUs=1000000000;MemoryBytes=2147483648}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia-llm')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{'app'='reader-ia';'reader.role'='contextual-translator'}
}
$llmExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-llm'} | Select-Object -First 1
if(-not $llmExisting){ Invoke-DockerJson "$base/services/create" 'Post' $llm | Out-Null; Write-Output 'llm_created' } else { Write-Output 'llm_reused' }
'''
if needle not in s: raise SystemExit('reader block not found')
s=s.replace(needle,block+needle,1)
s=s.replace("Env=@('PORT=8080','TRANSLATE_URL=http://reader-ia-translate:5000','TTS_URL=http://reader-ia-tts:8880')", "Env=@('PORT=8080','TRANSLATE_URL=http://reader-ia-translate:5000','TTS_URL=http://reader-ia-tts:8880','OLLAMA_URL=http://reader-ia-llm:11434','TRANSLATION_MODEL=qwen2.5:3b')",1)
p.write_text(s,encoding='utf-8')
print('local LLM service added to deploy')