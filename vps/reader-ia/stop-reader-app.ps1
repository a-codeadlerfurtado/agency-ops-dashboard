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
$svc=$services | Where-Object { $_.Spec.Name -eq 'reader-ia' } | Select-Object -First 1
if(-not $svc){ throw 'reader_app_service_not_found' }
$current=Invoke-DockerJson "$base/services/$($svc.ID)"
$spec=$current.Spec
$spec.Mode.Replicated.Replicas=0
Invoke-DockerJson "$base/services/$($svc.ID)/update?version=$($current.Version.Index)" 'Post' $spec | Out-Null
Write-Output 'stopped:reader-ia'
