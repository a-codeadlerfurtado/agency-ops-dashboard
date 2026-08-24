-- Recuperacao operacional do dashboard em 24/08/2026.
-- Objetivos:
-- 1. service_role consegue ler fontes usadas pela Home/Diario sem abrir acesso aos usuarios;
-- 2. jobs de alta frequencia deixam de iniciar em rajadas concorrentes;
-- 3. preserva ingestao/sincronizacao em lotes maiores e cadencia sustentavel.

grant select on table agency_ops.task_log_entries to service_role;
grant select on table agency_ops.client_adjustments to service_role;

-- Criticos / filas: slots distintos.
select cron.alter_job(job_id := 61, schedule := '1,11,21,31,41,51 * * * *', command := 'select agency_ops.zapi_direct_official_tick(1000);');
select cron.alter_job(job_id := 2,  schedule := '3,13,23,33,43,53 * * * *');
select cron.alter_job(job_id := 15, schedule := '5,20,35,50 * * * *');
select cron.alter_job(job_id := 16, schedule := '7,22,37,52 * * * *');
select cron.alter_job(job_id := 40, schedule := '9,24,39,54 * * * *');
select cron.alter_job(job_id := 50, schedule := '16,36 * * * *');
select cron.alter_job(job_id := 1,  schedule := '18,48 * * * *');
select cron.alter_job(job_id := 3,  schedule := '25,55 * * * *');
select cron.alter_job(job_id := 36, schedule := '27,57 * * * *');
select cron.alter_job(job_id := 66, schedule := '29,59 * * * *');
select cron.alter_job(job_id := 17, schedule := '30 * * * *');

-- Manutencao / sync: um slot por minuto, sem parede de jobs.
select cron.alter_job(job_id := 4,  schedule := '0 * * * *');
select cron.alter_job(job_id := 6,  schedule := '2 * * * *');
select cron.alter_job(job_id := 18, schedule := '4 * * * *');
select cron.alter_job(job_id := 19, schedule := '6 * * * *');
select cron.alter_job(job_id := 20, schedule := '8 * * * *');
select cron.alter_job(job_id := 21, schedule := '10 * * * *');
select cron.alter_job(job_id := 24, schedule := '12 * * * *');
select cron.alter_job(job_id := 26, schedule := '14 * * * *');
select cron.alter_job(job_id := 30, schedule := '15 * * * *');
select cron.alter_job(job_id := 31, schedule := '17 * * * *');
select cron.alter_job(job_id := 43, schedule := '19 * * * *');
select cron.alter_job(job_id := 44, schedule := '26 * * * *');
select cron.alter_job(job_id := 48, schedule := '28,58 * * * *');
select cron.alter_job(job_id := 57, schedule := '38 * * * *');
select cron.alter_job(job_id := 60, schedule := '40 * * * *');
select cron.alter_job(job_id := 62, schedule := '42 * * * *');
select cron.alter_job(job_id := 68, schedule := '44 * * * *');
select cron.alter_job(job_id := 72, schedule := '45 * * * *');
select cron.alter_job(job_id := 73, schedule := '46 * * * *');
select cron.alter_job(job_id := 74, schedule := '47 * * * *');
select cron.alter_job(job_id := 75, schedule := '49 * * * *');
select cron.alter_job(job_id := 42, schedule := '56 8-19 * * 1-5');
