$ErrorActionPreference='Stop'
$cred=Join-Path $env:LOCALAPPDATA 'Codex\Credentials\portainer-leonardoimobi.dpapi'
$secure=Get-Content $cred|ConvertTo-SecureString
$key=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$h=@{'X-API-Key'=$key};$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$services=Invoke-RestMethod "$base/services" -Headers $h
foreach($name in @('reader-ia','reader-ia-gemma','reader-ia-llm')){
  $s=$services|Where-Object {$_.Spec.Name -eq $name}|Select-Object -First 1
  if(!$s){Write-Host "MISSING $name";continue}
  Write-Host "==== $name $($s.ID) ===="
  $url="$base/services/$($s.ID)/logs?stdout=1&stderr=1&tail=80"
  try{$r=Invoke-WebRequest $url -Headers $h -UseBasicParsing;[Text.Encoding]::UTF8.GetString($r.Content)}catch{Write-Host $_}
}