-- Allowlist de e-mails para cadastro. Quem nao esta aqui nao cria conta - nao vira
-- usuario travado nem alerta no sino. Tabela separada de team_roster porque varias
-- pessoas usam mais de um e-mail (Felipe, Joel e Gabriel tem dois cada).
create table if not exists agency_ops.team_login_emails (
  email      text primary key,
  person     text not null,
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
alter table agency_ops.team_login_emails enable row level security;
create index if not exists team_login_emails_person_idx on agency_ops.team_login_emails (person);
comment on table agency_ops.team_login_emails is
  'Allowlist de e-mails para cadastro. O e-mail decide a qual colaborador o login sera vinculado.';

insert into agency_ops.team_login_emails (email, person, note)
select lower(r.email), r.person, 'e-mail do cadastro/ClickUp'
from agency_ops.team_roster r where not r.is_former and r.email is not null
on conflict (email) do nothing;

insert into agency_ops.team_login_emails (email, person, note) values
  ('felipeoliveira.gestormkt@gmail.com','Felipe Oliveira',   'informado pelo gestor'),
  ('yurim.gestor@gmail.com',            'Yuri Melo',         'informado pelo gestor'),
  ('adlerfurtadomkt01@gmail.com',       'Adler Furtado',     'informado pelo gestor'),
  ('joelxodo@gmail.com',                'Joel Antoniete',    'informado pelo gestor'),
  ('rodrigo.mktgestor@gmail.com',       'Rodrigo Cavalheiro','informado pelo gestor')
on conflict (email) do update set person=excluded.person, note=excluded.note, active=true;

-- Trava de cadastro. CUIDADO: auth.users e' compartilhado com o imobi-pro (915
-- usuarios, 909 criados em 30 dias). A trava so vale para cadastro vindo do
-- formulario do dashboard, identificado por collaborator_person no metadata.
create or replace function agency_ops.enforce_signup_allowlist()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
declare v_person text;
begin
  if not (coalesce(new.raw_user_meta_data,'{}'::jsonb) ? 'collaborator_person') then
    return new;
  end if;
  select l.person into v_person from agency_ops.team_login_emails l
   where l.active and l.email = lower(trim(new.email));
  if v_person is null then
    raise exception 'E-mail nao autorizado a criar conta no dashboard. Fale com o gestor.'
      using errcode = '42501';
  end if;
  -- O e-mail e' a fonte da verdade: mesmo escolhendo outro nome no dropdown, o
  -- login vai para o colaborador dono do e-mail.
  new.raw_user_meta_data := coalesce(new.raw_user_meta_data,'{}'::jsonb)
                            || jsonb_build_object('collaborator_person', v_person);
  return new;
end; $$;

drop trigger if exists enforce_signup_allowlist_trg on auth.users;
create trigger enforce_signup_allowlist_trg
before insert on auth.users
for each row execute function agency_ops.enforce_signup_allowlist();
