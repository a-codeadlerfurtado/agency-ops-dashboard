from pathlib import Path
p=Path(r'C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\deploy-reader.ps1')
s=p.read_text(encoding='utf-8')
s=s.replace("ollama pull translategemma:4b; ollama pull qwen2.5:3b; wait $pid", "ollama pull qwen2.5:3b; wait $pid")
needle="$reader=@{\n"
block=r'''$gemma=@{
  Name='reader-ia-gemma'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='ollama/ollama:latest'
      Command=@('/bin/sh','-lc','ollama serve & pid=$!; until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull translategemma:4b; wait $pid')
      Env=@('OLLAMA_HOST=0.0.0.0:11434','OLLAMA_KEEP_ALIVE=30m','OLLAMA_NUM_PARALLEL=1')
      Mounts=@(@{Type='volume';Source='reader-ia-translategemma-data';Target='/root/.ollama'})
    }
    RestartPolicy=@{Condition='on-failure';Delay=5000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=3500000000;MemoryBytes=6442450944};Reservations=@{NanoCPUs=500000000;MemoryBytes=2147483648}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia-gemma')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{'app'='reader-ia';'reader.role'='translation-gemma'}
}
$gemmaExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-gemma'} | Select-Object -First 1
if(-not $gemmaExisting){ Invoke-DockerJson "$base/services/create" 'Post' $gemma | Out-Null; Write-Output 'gemma_created' } else { Write-Output 'gemma_reused' }
'''
if needle not in s: raise SystemExit('reader marker missing')
s=s.replace(needle,block+needle,1)
s=s.replace("'OLLAMA_URL=http://reader-ia-llm:11434','TRANSLATION_MODEL=translategemma:4b'", "'OLLAMA_URL=http://reader-ia-gemma:11434','QWEN_URL=http://reader-ia-llm:11434','TRANSLATION_MODEL=translategemma:4b'")
p.write_text(s,encoding='utf-8')
print('separate TranslateGemma service added')