$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$imgs=Invoke-RestMethod 'https://portainer.leonardoimobi.com.br/api/endpoints/1/docker/images/json' -Headers $headers
$imgs | Where-Object {$_.RepoTags -and ($_.RepoTags -join ',') -match 'readerpro-openvoice'} | Select-Object Id,RepoTags,Size
