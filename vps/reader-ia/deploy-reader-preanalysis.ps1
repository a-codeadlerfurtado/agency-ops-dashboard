$ErrorActionPreference='Stop'
$dir=Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$networkName='LeonardoImobi'
$readerHost='portainer.leonardoimobi.com.br'
$readerPath='/reader'

function Invoke-DockerJson($url,$method='Get',$body=$null){
  if($null -eq $body){return Invoke-RestMethod $url -Headers $headers -Method $method}
  $json=$body | ConvertTo-Json -Depth 40 -Compress
  return Invoke-RestMethod $url -Headers $headers -Method $method -ContentType 'application/json' -Body $json
}

$networks=Invoke-DockerJson "$base/networks"
$network=$networks | Where-Object {$_.Name -eq $networkName} | Select-Object -First 1
if(!$network){throw "network_not_found:$networkName"}
$services=Invoke-DockerJson "$base/services"
foreach($name in @('reader-ia')){
  $old=$services | Where-Object {$_.Spec.Name -eq $name} | Select-Object -First 1
  if($old){
    Invoke-RestMethod "$base/services/$($old.ID)" -Headers $headers -Method Delete | Out-Null
    Write-Output "removed:$name"
  }
}

function New-DockerConfig($name,$path){
  $bytes=[IO.File]::ReadAllBytes($path)
  $body=@{
    Name=$name
    Data=[Convert]::ToBase64String($bytes)
    Labels=@{'app'='reader-ia'}
  }
  return Invoke-DockerJson "$base/configs/create" 'Post' $body
}

$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$serverCfg=New-DockerConfig "reader-ia-server-$stamp" (Join-Path $dir 'server.py')
$indexCfg=New-DockerConfig "reader-ia-index-$stamp" (Join-Path $dir 'index.html')
$profileCfg=New-DockerConfig "reader-ia-kotler-profile-$stamp" (Join-Path $dir 'kotler15_profile.json')
Write-Output 'configs_created'
$translator=@{
  Name='reader-ia-translate'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='libretranslate/libretranslate:latest'
      Env=@('LT_LOAD_ONLY=en,pt','LT_DISABLE_WEB_UI=true','LT_THREADS=4')
    }
    RestartPolicy=@{Condition='on-failure';Delay=5000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=4000000000;MemoryBytes=4294967296};Reservations=@{NanoCPUs=500000000;MemoryBytes=536870912}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia-translate')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{'app'='reader-ia';'reader.role'='translator'}
}
$translatorExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-translate'} | Select-Object -First 1
if(-not $translatorExisting){ Invoke-DockerJson "$base/services/create" 'Post' $translator | Out-Null; Write-Output 'translator_created' } else { Write-Output 'translator_reused' }
$tts=@{
  Name='reader-ia-tts'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='hwdsl2/kokoro-server:latest'
      Env=@('KOKORO_VOICE=pm_alex','KOKORO_SPEED=1.0','KOKORO_PORT=8880','KOKORO_API_KEY=','KOKORO_LOG_LEVEL=INFO','KOKORO_DISABLE_USAGE_COUNTS=1')
      Mounts=@(@{Type='volume';Source='reader-ia-kokoro-data';Target='/var/lib/kokoro'})
    }
    RestartPolicy=@{Condition='on-failure';Delay=5000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=4000000000;MemoryBytes=5368709120};Reservations=@{NanoCPUs=500000000;MemoryBytes=1610612736}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia-tts')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{'app'='reader-ia';'reader.role'='tts'}
}
$ttsExisting=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-tts'} | Select-Object -First 1
if(-not $ttsExisting){ Invoke-DockerJson "$base/services/create" 'Post' $tts | Out-Null; Write-Output 'tts_created' } else { Write-Output 'tts_reused' }
$llm=@{
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
$gemma=@{
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
$reader=@{
  Name='reader-ia'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='python:3.12-alpine'
      Command=@('python','/app/server.py')
      Env=@('PORT=8080','TRANSLATE_URL=http://reader-ia-translate:5000','TTS_URL=http://reader-ia-tts:8880','OLLAMA_URL=http://reader-ia-gemma:11434','QWEN_URL=http://reader-ia-llm:11434','TRANSLATION_MODEL=translategemma:4b','CACHE_ROOT=/cache')
      Mounts=@(@{Type='volume';Source='readerpro-reader-cache';Target='/cache'})
      Configs=@(
        @{ConfigID=$serverCfg.ID;ConfigName="reader-ia-server-$stamp";File=@{Name='/app/server.py';UID='0';GID='0';Mode=292}},
        @{ConfigID=$indexCfg.ID;ConfigName="reader-ia-index-$stamp";File=@{Name='/app/index.html';UID='0';GID='0';Mode=292}},
        @{ConfigID=$profileCfg.ID;ConfigName="reader-ia-kotler-profile-$stamp";File=@{Name='/app/kotler15_profile.json';UID='0';GID='0';Mode=292}}
      )
    }
    RestartPolicy=@{Condition='on-failure';Delay=3000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=1000000000;MemoryBytes=536870912};Reservations=@{NanoCPUs=100000000;MemoryBytes=67108864}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{
    'app'='reader-ia'
    'traefik.enable'='true'
    'traefik.docker.network'=$networkName
    'traefik.http.routers.reader-ia.entrypoints'='websecure'
    'traefik.http.routers.reader-ia.priority'='20'
    'traefik.http.routers.reader-ia.rule'="Host(``$readerHost``) && PathPrefix(``$readerPath``)"
    'traefik.http.routers.reader-ia.middlewares'='reader-ia-strip'
    'traefik.http.middlewares.reader-ia-strip.stripprefix.prefixes'=$readerPath
    'traefik.http.routers.reader-ia.service'='reader-ia'
    'traefik.http.routers.reader-ia.tls.certresolver'='letsencryptresolver'
    'traefik.http.services.reader-ia.loadbalancer.passHostHeader'='true'
    'traefik.http.services.reader-ia.loadbalancer.server.port'='8080'
  }
}
Invoke-DockerJson "$base/services/create" 'Post' $reader | Out-Null
Write-Output 'reader_created'
Write-Output "url=https://$readerHost$readerPath/"
