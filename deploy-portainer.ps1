$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialDir=Join-Path $env:LOCALAPPDATA 'Codex\Credentials'
$secure=Get-Content (Join-Path $credentialDir 'portainer-leonardoimobi.dpapi') | ConvertTo-SecureString
$headers=@{'X-API-Key'=(New-Object System.Net.NetworkCredential('token',$secure)).Password}
$base='https://portainer.leonardoimobi.com.br/api/endpoints/1/docker'
$networkName='LeonardoImobi'
$hostName='app.leonardoimobi.com.br'
function Invoke-DockerJson($url,$method='Get',$body=$null){
  if($null -eq $body){return Invoke-RestMethod $url -Headers $headers -Method $method}
  $json=$body | ConvertTo-Json -Depth 60 -Compress
  return Invoke-RestMethod $url -Headers $headers -Method $method -ContentType 'application/json' -Body $json
}
function New-SecretValue([int]$bytes=32){
  $b=New-Object byte[] $bytes; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+','-').Replace('/','_')
}
$secretsFile=Join-Path $credentialDir 'imobia-prod-secrets.dpapi'
if(Test-Path $secretsFile){
  $secJson=Get-Content $secretsFile | ConvertTo-SecureString
  $json=(New-Object System.Net.NetworkCredential('x',$secJson)).Password
  $secrets=$json | ConvertFrom-Json
} else {
  $encBytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($encBytes); $rng.Dispose()
  $secrets=[pscustomobject]@{
    DbPassword=New-SecretValue 30
    AppPassword=New-SecretValue 30
    RedisPassword=New-SecretValue 30
    MinioAccess=('imobia'+(New-SecretValue 12).Substring(0,12))
    MinioSecret=New-SecretValue 36
    EncryptionKey=[Convert]::ToBase64String($encBytes)
    VerifyToken=New-SecretValue 32
    AgentToken=New-SecretValue 48
  }
  $plain=$secrets|ConvertTo-Json -Compress
  $plain|ConvertTo-SecureString -AsPlainText -Force|ConvertFrom-SecureString|Set-Content $secretsFile
}
Write-Host 'secrets_ready'
$networks=Invoke-DockerJson "$base/networks"
$publicNetwork=$networks|Where-Object {$_.Name -eq $networkName}|Select-Object -First 1
if(!$publicNetwork){throw "network_not_found:$networkName"}
$internal=$networks|Where-Object {$_.Name -eq 'imobia-internal'}|Select-Object -First 1
if(!$internal){
  $internal=Invoke-DockerJson "$base/networks/create" 'Post' @{Name='imobia-internal';Driver='overlay';Attachable=$true;CheckDuplicate=$true}
  $internal=[pscustomobject]@{Id=$internal.Id;Name='imobia-internal'}
}
foreach($v in @('imobia-postgres-data','imobia-redis-data','imobia-minio-data')){
  try { Invoke-DockerJson "$base/volumes/create" 'Post' @{Name=$v;Driver='local'} | Out-Null } catch {}
}
$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
function New-DockerConfig($name,$path){
  $bytes=[IO.File]::ReadAllBytes($path)
  $full="imobia-$name-$stamp"
  $cfg=Invoke-DockerJson "$base/configs/create" 'Post' @{Name=$full;Data=[Convert]::ToBase64String($bytes);Labels=@{'app'='imobia'}}
  return [pscustomobject]@{ID=$cfg.ID;Name=$full}
}
$configMounts=@()
$runtimeFiles=@((Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json'))
$runtimeFiles += Get-ChildItem (Join-Path $repo 'dist') -Recurse -File | Select-Object -ExpandProperty FullName
$runtimeFiles += Get-ChildItem (Join-Path $repo 'db') -Recurse -File | Select-Object -ExpandProperty FullName
foreach($file in $runtimeFiles){
  $rel=$file.Substring($repo.Length+1).Replace('\','/')
  $safe=($rel -replace '[^a-zA-Z0-9_.-]','-')
  $cfg=New-DockerConfig $safe $file
  $configMounts += @{ConfigID=$cfg.ID;ConfigName=$cfg.Name;File=@{Name="/app/$rel";UID='0';GID='0';Mode=292}}
}
Write-Host ("configs_ready="+$configMounts.Count)
$services=Invoke-DockerJson "$base/services"
$ourNames=@('imobia-api','imobia-worker','imobia-migrate','imobia-postgres','imobia-redis','imobia-minio')
foreach($name in $ourNames){
  $old=$services|Where-Object {$_.Spec.Name -eq $name}|Select-Object -First 1
  if($old){Invoke-RestMethod "$base/services/$($old.ID)" -Headers $headers -Method Delete|Out-Null; Write-Host "removed:$name"}
}
Start-Sleep -Seconds 2
$restart=@{Condition='on-failure';Delay=3000000000;MaxAttempts=0}
$pg=@{
 Name='imobia-postgres';TaskTemplate=@{ContainerSpec=@{
  Image='pgvector/pgvector:pg16';Env=@("POSTGRES_DB=imobia","POSTGRES_USER=postgres","POSTGRES_PASSWORD=$($secrets.DbPassword)")
  Mounts=@(@{Type='volume';Source='imobia-postgres-data';Target='/var/lib/postgresql/data'})
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=2000000000;MemoryBytes=2147483648};Reservations=@{NanoCPUs=200000000;MemoryBytes=268435456}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-postgres')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{'app'='imobia';'imobia.role'='postgres'}
}
Invoke-DockerJson "$base/services/create" 'Post' $pg|Out-Null
$redis=@{
 Name='imobia-redis';TaskTemplate=@{ContainerSpec=@{
  Image='redis:7-alpine';Command=@('redis-server','--appendonly','yes','--requirepass',$secrets.RedisPassword)
  Mounts=@(@{Type='volume';Source='imobia-redis-data';Target='/data'})
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=500000000;MemoryBytes=536870912};Reservations=@{NanoCPUs=50000000;MemoryBytes=67108864}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-redis')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{'app'='imobia';'imobia.role'='redis'}
}
Invoke-DockerJson "$base/services/create" 'Post' $redis|Out-Null
$minio=@{
 Name='imobia-minio';TaskTemplate=@{ContainerSpec=@{
  Image='quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z';Command=@('minio','server','/data','--console-address',':9001')
  Env=@("MINIO_ROOT_USER=$($secrets.MinioAccess)","MINIO_ROOT_PASSWORD=$($secrets.MinioSecret)")
  Mounts=@(@{Type='volume';Source='imobia-minio-data';Target='/data'})
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=1000000000;MemoryBytes=1073741824};Reservations=@{NanoCPUs=100000000;MemoryBytes=134217728}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-minio')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{'app'='imobia';'imobia.role'='minio'}
}
Invoke-DockerJson "$base/services/create" 'Post' $minio|Out-Null

$appUrl="postgresql://imobi_app:$($secrets.AppPassword)@imobia-postgres:5432/imobia"
$migrationUrl="postgresql://postgres:$($secrets.DbPassword)@imobia-postgres:5432/imobia"
$redisUrl="redis://:$($secrets.RedisPassword)@imobia-redis:6379/0"
$commonEnv=@(
 'NODE_ENV=production','PORT=3001',"DATABASE_URL=$appUrl","REDIS_URL=$redisUrl",
 'MINIO_ENDPOINT=imobia-minio','MINIO_PORT=9000',"MINIO_ACCESS_KEY=$($secrets.MinioAccess)","MINIO_SECRET_KEY=$($secrets.MinioSecret)",'MINIO_BUCKET=imobia-media',
 "META_APP_ID=$($secrets.MetaAppId)",'META_APP_SECRET=',"META_BROKER_URL=$($secrets.MetaBrokerUrl)","META_BROKER_TOKEN=$($secrets.MetaBrokerToken)","META_VERIFY_TOKEN=$($secrets.VerifyToken)",'META_GRAPH_VERSION=v26.0','META_EMBEDDED_SIGNUP_CONFIG_ID=','META_EMBEDDED_SIGNUP_EXTRAS_JSON={}',
 "APP_ENCRYPTION_KEY_B64=$($secrets.EncryptionKey)","INTERNAL_AGENT_TOKEN=$($secrets.AgentToken)",'N8N_AGENT_WEBHOOK=http://n8n_n8n_webhook:5678/webhook/ImoBiaCore202609/webhook/imobia-agent','N8N_FOLLOWUP_WEBHOOK=http://n8n_n8n_webhook:5678/webhook/ImoBiaCore202609/webhook/imobia-agent'
)
$nodeCommand=@('/bin/sh','-lc','cd /app && npm ci --omit=dev --no-audit --no-fund && node dist/index.js')
$workerCommand=@('/bin/sh','-lc','cd /app && npm ci --omit=dev --no-audit --no-fund && node dist/worker.js')
$migrateCommand=@('/bin/sh','-lc','cd /app && npm ci --omit=dev --no-audit --no-fund && node dist/migrate.js')
$migrate=@{
 Name='imobia-migrate';TaskTemplate=@{ContainerSpec=@{
  Image='node:22-alpine';Command=$migrateCommand;Env=($commonEnv+@("MIGRATION_DATABASE_URL=$migrationUrl","IMOBI_APP_PASSWORD=$($secrets.AppPassword)"));Configs=$configMounts;WorkingDir='/app'
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=1000000000;MemoryBytes=1073741824};Reservations=@{NanoCPUs=100000000;MemoryBytes=134217728}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-migrate')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{'app'='imobia';'imobia.role'='migrate'}
}
Invoke-DockerJson "$base/services/create" 'Post' $migrate|Out-Null

$api=@{
 Name='imobia-api';TaskTemplate=@{ContainerSpec=@{
  Image='node:22-alpine';Command=$nodeCommand;Env=$commonEnv;Configs=$configMounts;WorkingDir='/app'
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=1500000000;MemoryBytes=1073741824};Reservations=@{NanoCPUs=100000000;MemoryBytes=134217728}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-api')},@{Target=$publicNetwork.Id;Aliases=@('imobia-api')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{
  'app'='imobia';'imobia.role'='api';'traefik.enable'='true';'traefik.docker.network'=$networkName;
  'traefik.http.services.imobia.loadbalancer.server.port'='3001';'traefik.http.services.imobia.loadbalancer.passHostHeader'='true';
  'traefik.http.routers.imobia-preview.entrypoints'='websecure';'traefik.http.routers.imobia-preview.rule'='Host(`portainer.leonardoimobi.com.br`) && PathPrefix(`/imobia`)';
  'traefik.http.routers.imobia-preview.middlewares'='imobia-preview-strip';'traefik.http.routers.imobia-preview.service'='imobia';'traefik.http.routers.imobia-preview.tls.certresolver'='letsencryptresolver';
  'traefik.http.middlewares.imobia-preview-strip.stripprefix.prefixes'='/imobia'
 }
}
Invoke-DockerJson "$base/services/create" 'Post' $api|Out-Null

$worker=@{
 Name='imobia-worker';TaskTemplate=@{ContainerSpec=@{
  Image='node:22-alpine';Command=$workerCommand;Env=$commonEnv;Configs=$configMounts;WorkingDir='/app'
 };RestartPolicy=$restart;Resources=@{Limits=@{NanoCPUs=1500000000;MemoryBytes=1073741824};Reservations=@{NanoCPUs=100000000;MemoryBytes=134217728}};Networks=@(@{Target=$internal.Id;Aliases=@('imobia-worker')},@{Target=$publicNetwork.Id;Aliases=@('imobia-worker')})};Mode=@{Replicated=@{Replicas=1}};EndpointSpec=@{Mode='vip'};Labels=@{'app'='imobia';'imobia.role'='worker'}
}
Invoke-DockerJson "$base/services/create" 'Post' $worker|Out-Null
Write-Host 'services_created'
Write-Host "url=https://$hostName/"
