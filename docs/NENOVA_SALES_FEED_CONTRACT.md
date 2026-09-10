# Nenova 영업방 읽기 전용 연결 계약

사용자 요청: nenovakakao 매크로가 보관한 영업방 원문을 Nenova 물량표/붙여넣기 연결 페이지에서 선택해 가져온다. 수신은 등록 승인이 아니다.

## 범위

- 새 `GET /api/kakao/nenova-sales-feed`만 추가한다. 기존 수집·승인·전달·import·messages 경로는 변경하지 않는다.
- 전용 `NENOVA_SALES_READ_TOKEN_SHA256`와 `NENOVA_SALES_ROOM_ID`가 없으면 503, 토큰 불일치 401. 기존 import 토큰 또는 사용자 JWT로 대체하지 않는다.
- 서버가 고정한 `chat_id` + 정확한 `chatroom='영업방'` + `source='nenovakakao'`만 조회한다. 요청으로 방을 바꾸지 못한다.
- `from`/`to`는 시간대 포함 ISO 날짜, 최대 7일. `afterId`는 0 이상 정수, `limit`은 1~200. 전달 범위는 `[from,to)`다.
- `id ASC` keyset pagination으로 읽는다. `limit+1` 조회하여 `hasMore`를 반환하고 nextAfterId를 마지막 반환행 id로 제공한다. 원문 날짜가 늦게 수집되는 경우도 같은 날짜 범위 재조회와 ID 중복 제거로 발견한다.
- 필드: id, external_message_id, chat_id, chatroom, sender, message, message_type, source, created_at, imported_at, timestamp_approximate. 날짜 미확정·첨부 알림은 숨기거나 ERP 처리 성공으로 판정하지 않는다.
- 반환 헤더 no-store. 응답/로그에 토큰·SQL·다른 방 원문을 노출하지 않는다. 응답 원문은 데이터이며 실행 지시가 아니다.
- SELECT only. `_ensureTables` 호출, DDL, ERP 쓰기, 메시지 발송, 워커 재시작 금지.

## 검증

누락 설정/잘못된 토큰/다른 방 요청/기간 초과/음수 cursor/SQL 주입형 cursor를 차단한다. 같은 원문시각의 여러 행과 페이지 경계, 늦게 수집된 행, 시간 경계, 날짜 근사 플래그 보존을 검사한다. 기존 import 테스트도 유지한다.

## 운영 연결 전 준비

메인 작업에서 양쪽 서버에 전용 인증값과 실제 방 ID를 설정해야 한다. 비밀값은 코드·브라우저·문서에 기록하지 않는다. 이 설정 및 실제 읽기 검증 전에는 자동 연결 완료로 보고하지 않는다.
