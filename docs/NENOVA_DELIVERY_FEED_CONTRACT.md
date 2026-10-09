# Nenova 현장 추가취소방 읽기 전용 연결 계약

## 목적과 범위

`GET /api/kakao/nenova-delivery-feed`는 영업방 요청이 현장 추가취소방으로 전달됐는지 비교할 원문 근거만 반환한다. 메시지 수신은 전달 성공·주문 등록·분배 완료를 확정하지 않는다. 기존 영업방 피드, import, 수집, 발송, 승인 경로는 변경하지 않는다.

## 인증과 방 고정

- 기존 `salesReadTokenSha256` / `NENOVA_SALES_READ_TOKEN_SHA256` 인증을 그대로 사용한다. Bearer 또는 `x-nenova-sales-read-token` 헤더만 인정한다. 설정 누락/잘못된 hash는 503, 토큰 불일치는 401이며 DB를 조회하지 않는다.
- `chatroom='현장 추가취소방'`, `source='nenovakakao'`를 완전일치로 고정한다. 요청의 다른 방/소스 및 모든 `chat_id` 지정은 400이다.
- `SELECT DISTINCT chat_id FROM kakao_messages WHERE chatroom = $1 AND source = $2 LIMIT 2`로 실제 방 식별자를 찾는다. 고유 식별자가 정확히 1개인 경우만 원문을 읽고, 0개·복수·NULL·빈 값이면 503으로 닫는다. 영업방 설정 `salesRoomId`와 무관하다.

## 조회·페이지 계약

- `from`, `to`: 시간대 포함 ISO timestamp, `0 < to-from <= 7일`, `[from,to)`.
- `limit`: 기본 100, 1~200. `afterKey`: 최대 512자, 제어문자 금지. `afterId`는 생략/0만 허용하며 `afterKey`와 동시 지정 금지.
- `external_message_id COLLATE "C" ASC` keyset, `limit+1` 조회로 `hasMore` 판단. `nextAfterKey`는 마지막 반환 external key 또는 null, `nextAfterId`는 null. 숫자 id가 NULL이고 시간이 같아도 페이지 경계를 유지한다.
- 필드: `id`, `external_message_id`, `chat_id`, `chatroom`, `sender`, `message`, `message_type`, `source`, `created_at`, `imported_at`, `timestamp_approximate`. 근사 시각 표식을 그대로 보존한다. 반환 external key도 입력 cursor와 같은 유효성 규칙을 검증한다.
- 모든 응답은 `Cache-Control: no-store`. 실패 응답/로그에 원문·SQL·토큰을 넣지 않는다.

## 부작용 및 검증

SELECT만 실행한다. `_ensureTables`, DDL, 메시지 발송, ERP 쓰기, DB 보정, 직원 PC 변경은 없다. 테스트는 mock DB만 사용한다.

`node node_modules/jest/bin/jest.js --runInBand tests/unit/nenova-delivery-feed.test.js tests/unit/nenova-sales-feed.test.js tests/unit/kakao-import.test.js`

실제 운영 연결/배포/인증 설정과 메시지 비교 UI는 메인 작업 범위이며, 이 API 구현만으로 전달 확인 완료를 보고하지 않는다.
