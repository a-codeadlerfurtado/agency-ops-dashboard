create index if not exists video_critic_runs_render_job_idx
  on agency_ops.video_critic_runs(render_job_id);

create index if not exists video_critic_runs_output_idx
  on agency_ops.video_critic_runs(output_id);
