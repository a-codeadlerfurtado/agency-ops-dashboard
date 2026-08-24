-- Reduz thundering herd no Postgres: preserva a cadencia operacional,
-- mas distribui jobs pesados ao longo dos minutos em vez de iniciar todos juntos.

select cron.alter_job(job_id := 40, schedule := '1-59/2 * * * *');
select cron.alter_job(job_id := 50, schedule := '2-59/3 * * * *');

select cron.alter_job(job_id := 1,  schedule := '0-58/2 * * * *');
select cron.alter_job(job_id := 3,  schedule := '1-59/2 * * * *');
select cron.alter_job(job_id := 15, schedule := '1-59/2 * * * *');
select cron.alter_job(job_id := 16, schedule := '0-58/2 * * * *');
select cron.alter_job(job_id := 36, schedule := '1-59/2 * * * *');
select cron.alter_job(job_id := 62, schedule := '7-59/10 * * * *');
select cron.alter_job(job_id := 66, schedule := '0-58/2 * * * *');
select cron.alter_job(job_id := 68, schedule := '4-59/5 * * * *');

select cron.alter_job(job_id := 17, schedule := '1-59/5 * * * *');
select cron.alter_job(job_id := 57, schedule := '2-59/5 * * * *');
select cron.alter_job(job_id := 72, schedule := '3-59/5 * * * *');
select cron.alter_job(job_id := 74, schedule := '4-59/5 * * * *');

select cron.alter_job(job_id := 18, schedule := '2-59/10 * * * *');
select cron.alter_job(job_id := 30, schedule := '7-59/10 * * * *');

select cron.alter_job(job_id := 6,  schedule := '1,16,31,46 * * * *');
select cron.alter_job(job_id := 26, schedule := '4,19,34,49 * * * *');
select cron.alter_job(job_id := 43, schedule := '7,22,37,52 * * * *');
select cron.alter_job(job_id := 60, schedule := '10,25,40,55 * * * *');

select cron.alter_job(job_id := 19, schedule := '6,26,46 * * * *');
select cron.alter_job(job_id := 4,  schedule := '2,32 * * * *');
select cron.alter_job(job_id := 20, schedule := '7,37 * * * *');
select cron.alter_job(job_id := 21, schedule := '12,42 * * * *');
select cron.alter_job(job_id := 24, schedule := '17,47 * * * *');
select cron.alter_job(job_id := 44, schedule := '22,52 * * * *');
select cron.alter_job(job_id := 48, schedule := '27,57 * * * *');
select cron.alter_job(job_id := 42, schedule := '5,35 8-19 * * 1-5');
