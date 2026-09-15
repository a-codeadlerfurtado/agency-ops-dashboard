$ErrorActionPreference='Stop'
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$apiKey=(New-Object System.Net.NetworkCredential('token',$secure)).Password
$headers=@{'X-API-Key'=$apiKey}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
function Invoke-DockerJson($url,$method='Get',$body=$null){
  if($null -eq $body){return Invoke-RestMethod $url -Headers $headers -Method $method}
  $json=$body|ConvertTo-Json -Depth 60 -Compress
  return Invoke-RestMethod $url -Headers $headers -Method $method -ContentType 'application/json' -Body $json
}
$services=Invoke-DockerJson "$base/services"
$editor=$services|Where-Object {$_.Spec.Name -eq 'n8n_n8n_editor'}|Select-Object -First 1
if(!$editor){throw 'n8n_editor_not_found'}
$workflowPath=Join-Path $PSScriptRoot 'imobia-agent-runtime-ideal-template.json'
$bytes=[IO.File]::ReadAllBytes($workflowPath)
$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$cfg=Invoke-DockerJson "$base/configs/create" 'Post' @{Name="imobia-agent-runtime-ideal-$stamp";Data=[Convert]::ToBase64String($bytes);Labels=@{'app'='imobia';'role'='n8n-import'}}
function Remove-ServiceByName($name){
  $all=Invoke-DockerJson "$base/services"
  $old=$all|Where-Object {$_.Spec.Name -eq $name}|Select-Object -First 1
  if($old){Invoke-RestMethod "$base/services/$($old.ID)" -Headers $headers -Method Delete|Out-Null; Start-Sleep -Seconds 2}
}
function New-N8nCliService($name,$command,$configs=@()){
  Remove-ServiceByName $name
  $spec=@{
    Name=$name
    TaskTemplate=@{ContainerSpec=@{
      Image=$editor.Spec.TaskTemplate.ContainerSpec.Image
      Env=$editor.Spec.TaskTemplate.ContainerSpec.Env
      Command=$command
      Configs=$configs
    };RestartPolicy=@{Condition='none'};Networks=$editor.Spec.TaskTemplate.Networks}
    Mode=@{Replicated=@{Replicas=1}}
    EndpointSpec=@{Mode='vip'}
    Labels=@{'app'='imobia';'role'='n8n-cli'}
  }
  return Invoke-DockerJson "$base/services/create" 'Post' $spec
}
function Wait-Task($serviceId,$label){
  for($i=0;$i -lt 30;$i++){
    $filters=[uri]::EscapeDataString((@{service=@($serviceId)}|ConvertTo-Json -Compress))
    $tasks=Invoke-DockerJson "$base/tasks?filters=$filters"
    $task=$tasks|Sort-Object {$_.Status.Timestamp} -Descending|Select-Object -First 1
    if($task -and $task.Status.State -in @('complete','failed','rejected')){
      Write-Host "$label=$($task.Status.State) $($task.Status.Err)"
      if($task.Status.State -ne 'complete'){throw "$label failed"}
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "$label timeout"
}
$mount=@{ConfigID=$cfg.ID;ConfigName="imobia-agent-runtime-ideal-$stamp";File=@{Name='/tmp/imobia-agent-runtime-ideal-template.json';UID='1000';GID='1000';Mode=292}}
$import=New-N8nCliService 'imobia-n8n-template-import' @('n8n','import:workflow','--input=/tmp/imobia-agent-runtime-ideal-template.json') @($mount)
Wait-Task $import.ID 'import'
Write-Host 'n8n_template_ready'
