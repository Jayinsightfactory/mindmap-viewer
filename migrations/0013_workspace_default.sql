-- 0013: T0b 정합 마무리 — workspace_id 컬럼 DEFAULT를 실제 workspaces.id로.
-- T0b(2026-07-06)에서 기존 데이터는 'nenova'→'WS-NENOVA-2026'으로 이관했지만 컬럼 DEFAULT가
-- 'nenova'로 남아, workspace_id를 명시하지 않는 시더/매처(seed-person-from-pc-links,
-- bootstrap-customer, match-person-erp)의 신규 행이 조회 불가능한 옛 테넌트로 들어가는 회귀 발생.
ALTER TABLE orbit_entity_golden ALTER COLUMN workspace_id SET DEFAULT 'WS-NENOVA-2026';
ALTER TABLE ops_relation        ALTER COLUMN workspace_id SET DEFAULT 'WS-NENOVA-2026';
ALTER TABLE unified_events      ALTER COLUMN workspace_id SET DEFAULT 'WS-NENOVA-2026';

-- 이관 이후 DEFAULT로 새어 들어간 잔여 행 정리 (T0b 이후 신규분이라 소량 — 대량 UPDATE 아님)
UPDATE orbit_entity_golden SET workspace_id = 'WS-NENOVA-2026' WHERE workspace_id = 'nenova';
UPDATE ops_relation        SET workspace_id = 'WS-NENOVA-2026' WHERE workspace_id = 'nenova';
UPDATE unified_events      SET workspace_id = 'WS-NENOVA-2026' WHERE workspace_id = 'nenova';
