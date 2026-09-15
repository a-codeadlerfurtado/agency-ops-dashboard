$ErrorActionPreference='Stop'
$dir=Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
function Invoke-DockerJson($url,$method='Get',$body=$null){
  if($null -eq $body){return Invoke-RestMethod $url -Headers $headers -Method $method}
  $json=$body | ConvertTo-Json -Depth 40 -Compress
  Invoke-RestMethod $url -Headers $headers -Method $method -ContentType 'application/json' -Body $json
}
$network=(Invoke-DockerJson "$base/networks") | Where-Object {$_.Name -eq 'LeonardoImobi'} | Select-Object -First 1
if(!$network){throw 'LeonardoImobi network not found'}
$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$serverPath=Join-Path $dir 'readerpro-openvoice-image\tts_server.py'
$cfgBody=@{Name="readerpro-openvoice-tts-server-$stamp";Data=[Convert]::ToBase64String([IO.File]::ReadAllBytes($serverPath));Labels=@{'app'='reader-ia';'reader.role'='tts-config'}}
$ttsCfg=Invoke-DockerJson "$base/configs/create" 'Post' $cfgBody
$services=Invoke-DockerJson "$base/services"
$old=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-tts'} | Select-Object -First 1
if($old){Invoke-RestMethod "$base/services/$($old.ID)" -Headers $headers -Method Delete | Out-Null; Write-Output 'old_tts_removed'}
$svc=@{
  Name='reader-ia-tts'
  TaskTemplate=@{
    ContainerSpec=@{
      Image='readerpro-openvoice:20260909'
      Env=@('PORT=8880','TORCH_THREADS=4')
      Mounts=@(@{Type='volume';Source='readerpro-openvoice-cache';Target='/cache'})
      Configs=@(@{ConfigID=$ttsCfg.ID;ConfigName="readerpro-openvoice-tts-server-$stamp";File=@{Name='/app/tts_server.py';UID='0';GID='0';Mode=292}})
    }
    RestartPolicy=@{Condition='on-failure';Delay=5000000000;MaxAttempts=0}
    Resources=@{Limits=@{NanoCPUs=4000000000;MemoryBytes=4294967296};Reservations=@{NanoCPUs=500000000;MemoryBytes=1073741824}}
    Networks=@(@{Target=$network.Id;Aliases=@('reader-ia-tts')})
  }
  Mode=@{Replicated=@{Replicas=1}}
  EndpointSpec=@{Mode='vip'}
  Labels=@{'app'='reader-ia';'reader.role'='tts';'reader.voice'='jarvis-openvoice-v2'}
}
$r=Invoke-DockerJson "$base/services/create" 'Post' $svc
Write-Output "tts_created:$($r.ID)"
Start-Sleep -Seconds 4
$services=Invoke-DockerJson "$base/services"
$new=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-tts'} | Select-Object -First 1
if(!$new){throw 'new tts service not found'}
Write-Output "tts_image:$($new.Spec.TaskTemplate.ContainerSpec.Image)"
Write-Output "tts_config:$($ttsCfg.ID)"
