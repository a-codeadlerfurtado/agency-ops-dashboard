-- Setembro/2026: fechamento historico reconstruido, sem fabricar observacoes.
-- Fonte da base ativa: snapshot operacional preservado em 2026-09-30.
-- Entradas ativas: campo entrada do snapshot. Churns e vendas caidas:
-- log canonico confirmado. Setor do snapshot e' resolvido por clients.service
-- (nao armazenado no snapshot), logo qualidade ESTIMATED, nao HIGH.
DO $$
DECLARE
  total_snap integer;
  snap_valido integer;
BEGIN
  SELECT count(*), count(*) FILTER (
    WHERE c.id IS NOT NULL
      AND s.metadata->>'lifecycle' IN ('ACTIVE', 'ONBOARDING')
      AND s.metadata->>'entrada' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  )
  INTO total_snap, snap_valido
  FROM agency_ops.operational_capacity_snapshots s
  LEFT JOIN agency_ops.clients c ON c.id::text = s.scope_id
  WHERE s.snapshot_date = DATE '2026-09-30'
    AND s.scope_type = 'CLIENT';

  IF total_snap <> 103 OR snap_valido <> 103 THEN
    RAISE EXCEPTION 'Snapshot 2026-09-30 incompleto: % linhas, % validas (esperado: 103)', total_snap, snap_valido;
  END IF;
END $$;

WITH setores AS (
  SELECT unnest(ARRAY['marketing'::text,'ia'::text]) AS sector
),
snap AS (
  SELECT
    COALESCE(NULLIF(c.service, ''), 'marketing') AS sector,
    (s.metadata->>'entrada')::date AS entrada
  FROM agency_ops.operational_capacity_snapshots s
  JOIN agency_ops.clients c ON c.id::text = s.scope_id
  WHERE s.snapshot_date = DATE '2026-09-30'
    AND s.scope_type = 'CLIENT'
    AND s.metadata->>'lifecycle' IN ('ACTIVE', 'ONBOARDING')
),
ativos AS (
  SELECT sector,
    count(*)::integer AS active_clients,
    count(*) FILTER (WHERE DATE '2026-09-30' - entrada < 90)::integer AS clients_less_3m,
    count(*) FILTER (WHERE DATE '2026-09-30' - entrada BETWEEN 90 AND 179)::integer AS clients_3_6m,
    count(*) FILTER (WHERE DATE '2026-09-30' - entrada >= 180)::integer AS clients_over_6m,
    round(avg((DATE '2026-09-30' - entrada) / 30.0), 2) AS ltv_months,
    count(*) FILTER (WHERE entrada BETWEEN DATE '2026-09-01' AND DATE '2026-09-30')::integer AS entries
  FROM snap GROUP BY sector
),
saidas AS (
  SELECT sector,
    count(*) FILTER (WHERE tipo = 'churn')::integer AS churns,
    count(*) FILTER (WHERE tipo = 'venda_caida')::integer AS vendas_caidas,
    round(avg(permanencia_dias) FILTER (WHERE tipo = 'churn') / 30.0, 2) AS tpc_months
  FROM agency_ops.client_churn_log
  WHERE saida BETWEEN DATE '2026-09-01' AND DATE '2026-09-30'
    AND confirmed IS TRUE
  GROUP BY sector
),
base_potencial AS (
  SELECT COALESCE(NULLIF(service, ''), 'marketing') AS sector,
    count(*)::integer AS churn_base
  FROM agency_ops.clients
  WHERE entrada < DATE '2026-09-01'
    AND (saida IS NULL OR saida >= DATE '2026-09-01')
  GROUP BY 1
),
entradas_brutas AS (
  SELECT COALESCE(NULLIF(service, ''), 'marketing') AS sector,
    count(*)::integer AS gross_entries
  FROM agency_ops.clients
  WHERE entrada BETWEEN DATE '2026-09-01' AND DATE '2026-09-30'
  GROUP BY 1
)
INSERT INTO agency_ops.portfolio_monthly_history (
  month, label, reference_date, is_current, reconstructed,
  quality, quality_label, quality_detail, sector,
  active_clients, clients_less_3m, clients_3_6m, clients_over_6m,
  ltv_months, entries, churns, churn_base, churn_rate, tpc_months,
  balance, vendas_caidas, admin_removals, estimated_churns
)
SELECT DATE '2026-09-01', 'Setembro/2026', DATE '2026-09-30', false, true,
  'estimated', 'Reconstruído',
  'Base ativa e tempo de casa em snapshot operacional de 30/09; churns e vendas caídas no log confirmado; entradas por data de início. Classificação de setor e base potencial derivadas dos registros disponíveis atualmente. Reconstrução, não fechamento original.',
  s.sector,
  COALESCE(a.active_clients, 0),
  COALESCE(a.clients_less_3m, 0),
  COALESCE(a.clients_3_6m, 0),
  COALESCE(a.clients_over_6m, 0),
  a.ltv_months,
  COALESCE(a.entries, 0),
  COALESCE(x.churns, 0),
  COALESCE(b.churn_base, 0),
  CASE WHEN COALESCE(b.churn_base, 0) > 0 THEN round(100.0 * COALESCE(x.churns, 0) / b.churn_base, 1) ELSE 0 END,
  x.tpc_months,
  COALESCE(e.gross_entries, 0) - COALESCE(x.churns, 0) - COALESCE(x.vendas_caidas, 0),
  COALESCE(x.vendas_caidas, 0), 0, 0
FROM setores s
LEFT JOIN ativos a ON a.sector = s.sector
LEFT JOIN saidas x ON x.sector = s.sector
LEFT JOIN base_potencial b ON b.sector = s.sector
LEFT JOIN entradas_brutas e ON e.sector = s.sector
ON CONFLICT (month, sector) DO NOTHING;
