-- =========================================================================
-- Imobi-Board - seed de imoveis e interesse (spec 95)
-- Roda depois de seed.sql. Suficiente para o matching ter o que sugerir.
-- =========================================================================

insert into imobi_board.developments (id, tenant_id, name, city, state, neighborhood, delivery_at) values
  ('dddddddd-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','Vista Residence','Sao Paulo','SP','Aquarius','2027-06-30'),
  ('dddddddd-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001','Jardins Tower','Sao Paulo','SP','Jardins','2026-12-20'),
  ('dddddddd-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001','Terra Park','Sao Paulo','SP','Morumbi','2028-03-31')
on conflict (id) do nothing;

insert into imobi_board.properties
  (tenant_id, development_id, code, title, type, status, city, state, neighborhood,
   price, area_m2, bedrooms, suites, bathrooms, parking_spaces, condo_fee, features)
values
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','VR-101','Vista Residence - Unidade 101','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius', 890000, 92, 3, 1, 2, 2, 780, '{piscina,academia,varanda gourmet}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','VR-202','Vista Residence - Unidade 202','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius', 960000, 98, 3, 2, 3, 2, 820, '{piscina,academia,sacada}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','VR-305','Vista Residence - Unidade 305','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius',1180000,118, 4, 2, 3, 3, 980, '{piscina,academia,terraco}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001','VR-402','Vista Residence - Unidade 402','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius', 845000, 86, 2, 1, 2, 1, 720, '{piscina,academia}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000002','JT-110','Jardins Tower - Unidade 110','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Jardins',1450000,104, 3, 2, 3, 2, 1400, '{portaria 24h,coworking}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000002','JT-210','Jardins Tower - Unidade 210','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Jardins',1690000,132, 4, 3, 4, 3, 1750, '{portaria 24h,spa}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000003','TP-A12','Terra Park - Casa A12','CASA','AVAILABLE','Sao Paulo','SP','Morumbi',1980000,240, 4, 3, 5, 4, 1200, '{quintal,churrasqueira,piscina privativa}'),
  ('aaaaaaaa-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000003','TP-B04','Terra Park - Casa B04','CASA','AVAILABLE','Sao Paulo','SP','Morumbi',1650000,198, 3, 2, 4, 3, 1100, '{quintal,churrasqueira}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-001','Apartamento reformado no Aquarius','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius', 720000, 84, 3, 1, 2, 2, 640, '{reformado,mobiliado}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-002','Cobertura duplex nos Jardins','COBERTURA','AVAILABLE','Sao Paulo','SP','Jardins',2400000,210, 4, 3, 5, 4, 2100, '{duplex,vista livre}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-003','Sobrado no Morumbi','SOBRADO','AVAILABLE','Sao Paulo','SP','Morumbi',1250000,165, 3, 1, 3, 2, null, '{quintal}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-004','Apartamento compacto Aquarius','APARTAMENTO','AVAILABLE','Sao Paulo','SP','Aquarius', 480000, 58, 2, 0, 1, 1, 480, '{proximo ao metro}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-005','Terreno em Interlagos','TERRENO','AVAILABLE','Sao Paulo','SP','Interlagos', 390000, 300, null,null,null,null,null,'{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001',null,'US-006','Casa em Alto de Pinheiros','CASA','AVAILABLE','Sao Paulo','SP','Alto de Pinheiros',2850000,280, 4, 4, 5, 4, null, '{piscina,jardim}')
on conflict (tenant_id, code) do nothing;

-- imoveis da Horizonte: existem para confirmar que nao vazam no matching da
-- Terra Concreta
insert into imobi_board.properties
  (tenant_id, code, title, type, status, city, state, neighborhood, price, area_m2, bedrooms, parking_spaces)
values
  ('bbbbbbbb-0000-4000-8000-000000000002','HZ-01','Apartamento Asa Sul','APARTAMENTO','AVAILABLE','Brasilia','DF','Asa Sul', 920000, 95, 3, 2),
  ('bbbbbbbb-0000-4000-8000-000000000002','HZ-02','Casa no Lago Norte','CASA','AVAILABLE','Brasilia','DF','Lago Norte',1750000,210, 4, 3)
on conflict (tenant_id, code) do nothing;

-- Perfil de interesse no lead da Olivia: e o exemplo da spec 41
-- (Aquarius, ate 1 milhao, 3 quartos, 2 vagas, 90 m2+).
insert into imobi_board.lead_interests
  (tenant_id, opportunity_id, purchase_purpose, property_type, cities, neighborhoods,
   max_price, min_area, min_bedrooms, min_parking_spaces, financing_needed)
select o.tenant_id, o.id, 'MORAR', 'APARTAMENTO', '{"Sao Paulo"}', '{"Aquarius"}',
       1000000, 90, 3, 2, true
from imobi_board.opportunities o
join imobi_board.contacts c on c.id = o.contact_id
where c.full_name = 'Olivia Ramos'
on conflict (opportunity_id) do nothing;
