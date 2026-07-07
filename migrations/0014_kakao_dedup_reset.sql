-- 0014: 카카오 이벤트 중복 청소 (1회)
-- 과거 kakao-ontology-sync가 시트 시각 파싱 실패 시 ts=now()를 ID 해시에 포함해
-- 매 동기화(30분)마다 같은 행이 새 이벤트로 중복 적재됨. 안정 ID 도입과 함께 전량 삭제 —
-- 시트가 append-only 원본이라 다음 동기화에서 완전 재구축됨(데이터 손실 없음).
DELETE FROM ops_relation WHERE rel_type IN ('kakao_event_in_room', 'kakao_event_mentions_customer');
DELETE FROM unified_events WHERE type IN ('kakao.business_event', 'kakao.decision');
