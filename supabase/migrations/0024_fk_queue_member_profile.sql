-- Imobi-Board 0024 - a tela de Distribuicao nao carregava os membros da fila
--
-- PGRST200: "Could not find a relationship between 'queue_members' and
-- 'profiles'". queue_members.user_id aponta para auth.users, que o PostgREST
-- nao enxerga a partir do schema exposto; entao `profile:profiles(full_name)`
-- devolvia 400 e a lista de corretores da fila ficava vazia.
--
-- Mesma correcao da 0009 para memberships, que na epoca eu apliquei so na
-- tabela onde tinha visto o erro. Achado agora abrindo a tela: nenhum teste
-- de banco pega isso, porque o problema nao esta nos dados nem na RLS - esta
-- no que o PostgREST consegue inferir.
--
-- FK direta, e nao trigger em auth.users: essa tabela e compartilhada com os
-- outros sistemas do projeto e nao se mexe nela.

alter table imobi_board.queue_members
  add constraint queue_members_profile_fk
  foreign key (user_id) references imobi_board.profiles(id) on delete cascade;

notify pgrst, 'reload schema';
