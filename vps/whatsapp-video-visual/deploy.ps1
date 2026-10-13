param([ValidateSet('prepare','deploy','inspect')][string]$Mode='inspect')
$ErrorActionPreference='Stop'
$credRoot='C:\Users\Adler\AppData\Local\Codex\Credentials'
$j=Get-Content ($credRoot+'\access-portainer-login.dpapi') -Raw|ConvertFrom-Json
function Reveal($s){$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR(($s.Trim()|ConvertTo-SecureString));try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}}
$pw=Reveal $j.secrets.password
$a=Invoke-RestMethod ($j.metadata.url+'/api/auth') -Method Post -ContentType 'application/json' -Body (@{Username=$j.metadata.username;Password=$pw}|ConvertTo-Json) -TimeoutSec 20
$h=@{Authorization='Bearer '+$a.jwt}
$base=$j.metadata.url+'/api/endpoints/1/docker'
$tokenPath=$credRoot+'\whatsapp-video-worker.dpapi'
if($Mode -eq 'prepare'){
 if(!(Test-Path $tokenPath)){$bytes=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose();$token=([BitConverter]::ToString($bytes)).Replace('-','').ToLower();$token|ConvertTo-SecureString -AsPlainText -Force|ConvertFrom-SecureString|Set-Content $tokenPath}else{$token=Reveal (Get-Content $tokenPath -Raw)}
 $hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($token))).Replace('-','').ToLower()
 $secrets=Invoke-RestMethod ($base+'/secrets') -Headers $h
 $existing=$secrets|Where-Object {$_.Spec.Name -eq 'whatsapp_media_video_20261013'}
 if(!$existing){$existing=Invoke-RestMethod ($base+'/secrets/create') -Headers $h -Method Post -ContentType 'application/json' -Body (@{Name='whatsapp_media_video_20261013';Data=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($token));Labels=@{purpose='whatsapp-media-visual'}}|ConvertTo-Json -Depth 10)}
 Write-Output ('Token SHA256: '+$hash)
 Write-Output ('Secret ID: '+$existing.ID)
}
if($Mode -eq 'deploy'){
 $secrets=Invoke-RestMethod ($base+'/secrets') -Headers $h;$secret=$secrets|Where-Object {$_.Spec.Name -eq 'whatsapp_media_video_20261013'}
 if(!$secret){throw 'Prepared Docker secret missing'}
 $services=Invoke-RestMethod ($base+'/services') -Headers $h
 if($services|Where-Object {$_.Spec.Name -eq 'whatsapp-media-video-visual'}){throw 'Service already exists; inspect before update'}
 $video=$services|Where-Object {$_.Spec.Name -eq 'leonardo-video-worker-v4-shadow'}
 if(!$video){throw 'Existing FFmpeg image service missing'}
 $filters=[uri]::EscapeDataString((@{service=@($video.ID);'desired-state'=@('running')}|ConvertTo-Json -Compress))
 $tasks=Invoke-RestMethod ($base+'/tasks?filters='+$filters) -Headers $h
 $node=($tasks|Where-Object {$_.Status.State -eq 'running'}|Select-Object -First 1).NodeID
 if(!$node){throw 'FFmpeg node unavailable'}
 $code=Get-Content (Join-Path $PSScriptRoot 'worker.py') -Raw
 $spec=@{Name='whatsapp-media-video-visual';Labels=@{purpose='whatsapp-client-media';version='1.0.0'};TaskTemplate=@{ContainerSpec=@{Image=$video.Spec.TaskTemplate.ContainerSpec.Image;User='10001:10001';Command=@('python','-c',"import os; exec(os.environ['MEDIA_VIDEO_SCRIPT'])");Env=@('PYTHONUNBUFFERED=1','PYTHONDONTWRITEBYTECODE=1','MEDIA_VIDEO_API_URL=https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-whatsapp-video-visual-api',('MEDIA_VIDEO_SCRIPT='+$code));Secrets=@(@{SecretID=$secret.ID;SecretName=$secret.Spec.Name;File=@{Name='media_video_token';UID='10001';GID='10001';Mode=256}});Healthcheck=@{Test=@('CMD','python','-c',"import os,time; assert time.time()-os.stat('/tmp/media-video-heartbeat').st_mtime<600");Interval=30000000000;Timeout=5000000000;StartPeriod=60000000000;Retries=3}};Resources=@{Limits=@{NanoCPUs=500000000;MemoryBytes=536870912};Reservations=@{MemoryBytes=67108864}};Placement=@{Constraints=@('node.id=='+$node)};RestartPolicy=@{Condition='any';Delay=5000000000}};Mode=@{Replicated=@{Replicas=1}}}
 $created=Invoke-RestMethod ($base+'/services/create') -Headers $h -Method Post -ContentType 'application/json' -Body ($spec|ConvertTo-Json -Depth 20) -TimeoutSec 30
 Write-Output ('Created media visual service: '+$created.ID)
}
if($Mode -eq 'inspect'){
 $services=Invoke-RestMethod ($base+'/services') -Headers $h;$service=$services|Where-Object {$_.Spec.Name -eq 'whatsapp-media-video-visual'}
 if(!$service){Write-Output 'Media service missing';exit}
 $filters=[uri]::EscapeDataString((@{service=@($service.ID)}|ConvertTo-Json -Compress))
 $tasks=Invoke-RestMethod ($base+'/tasks?filters='+$filters) -Headers $h
 $tasks|Select-Object ID,NodeID,@{n='State';e={$_.Status.State}},@{n='Error';e={$_.Status.Err}}|ConvertTo-Json -Compress
 try{$log=Invoke-WebRequest ($base+'/services/'+$service.ID+'/logs?stdout=true&stderr=true&tail=12') -Headers $h -UseBasicParsing;if($log.Content -is [byte[]]){[Text.Encoding]::UTF8.GetString($log.Content)}else{$log.Content}}catch{Write-Output 'Logs pending'}
}