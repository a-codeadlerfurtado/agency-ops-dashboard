$ErrorActionPreference='Stop'
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$tar='C:\Users\Adler\agency-ops-hetzner-worktree\vps\reader-ia\greene-only.tar'
try{$body=@{Name='readerpro-library'}|ConvertTo-Json -Compress;Invoke-RestMethod "$base/volumes/create" -Headers $headers -Method Post -ContentType 'application/json' -Body $body|Out-Null;Write-Output 'volume_ready'}catch{Write-Output 'volume_exists'}
$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$name="readerpro-library-loader-$stamp"
$body=@{Image='python:3.12-alpine';Cmd=@('sh','-c','sleep 600');HostConfig=@{Mounts=@(@{Type='volume';Source='readerpro-library';Target='/library'})}}|ConvertTo-Json -Depth 12 -Compress
$c=Invoke-RestMethod "$base/containers/create?name=$name" -Headers $headers -Method Post -ContentType 'application/json' -Body $body
$id=$c.Id
Invoke-RestMethod "$base/containers/$id/start" -Headers $headers -Method Post|Out-Null
Write-Output "loader_started:$id"
try{
  Invoke-WebRequest "$base/containers/$id/archive?path=/library" -Headers $headers -Method Put -InFile $tar -ContentType 'application/x-tar' -UseBasicParsing|Out-Null
  Write-Output 'library_archive_uploaded'
}finally{
  try{Invoke-RestMethod "$base/containers/$id?force=true" -Headers $headers -Method Delete|Out-Null}catch{}
  Write-Output 'loader_removed'
}


