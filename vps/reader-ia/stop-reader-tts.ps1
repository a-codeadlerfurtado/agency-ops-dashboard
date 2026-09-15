$ErrorActionPreference='Stop'
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'

function Invoke-DockerJson($url,$method='Get',$body=$null){
  if($null -eq $body){return Invoke-RestMethod $url -Headers $headers -Method $method}
  $json=$body | ConvertTo-Json -Depth 50 -Compress
  return Invoke-RestMethod $url -Headers $headers -Method $method -ContentType 'application/json' -Body $json
}

$services=Invoke-DockerJson "$base/services"
$targets=$services | Where-Object { $_.Spec.Name -like 'reader-ia-tts*' }
if(-not $targets){ throw 'reader_tts_service_not_found' }
foreach($svc in $targets){
  $current=Invoke-DockerJson "$base/services/$($svc.ID)"
  $spec=$current.Spec
  if($null -eq $spec.Mode.Replicated){ throw "not_replicated:$($spec.Name)" }
  $spec.Mode.Replicated.Replicas=0
  Invoke-DockerJson "$base/services/$($svc.ID)/update?version=$($current.Version.Index)" 'Post' $spec | Out-Null
  Write-Output "stopped:$($spec.Name)"
}
