$ErrorActionPreference='Stop'
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$headers=@{'X-API-Key'=(New-Object System.Net.NetworkCredential('token',$secure)).Password}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$services=Invoke-RestMethod "$base/services" -Headers $headers
foreach($name in @('agency-processor_donnah-processor','agency-processor_form-sheets-processor')) {
  $svc=$services | Where-Object {$_.Spec.Name -eq $name} | Select-Object -First 1
  if(!$svc){ throw "service_not_found:$name" }
  if($null -eq $svc.Spec.TaskTemplate.ForceUpdate){ $svc.Spec.TaskTemplate | Add-Member -NotePropertyName ForceUpdate -NotePropertyValue 1 }
  else { $svc.Spec.TaskTemplate.ForceUpdate=[int]$svc.Spec.TaskTemplate.ForceUpdate+1 }
  $body=$svc.Spec | ConvertTo-Json -Depth 30
  Invoke-RestMethod ("$base/services/{0}/update?version={1}" -f $svc.ID,$svc.Version.Index) -Method Post -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  Write-Output "FORCED=$name"
}
