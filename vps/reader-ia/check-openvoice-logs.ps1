$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$services=Invoke-RestMethod "$base/services" -Headers $headers
$svc=$services | Where-Object {$_.Spec.Name -eq 'reader-ia-tts'} | Select-Object -First 1
if(!$svc){throw 'service missing'}
$url="$base/services/$($svc.ID)/logs?stdout=1&stderr=1&timestamps=0&tail=80"
$r=Invoke-WebRequest $url -Headers $headers
[Text.Encoding]::UTF8.GetString($r.Content)
