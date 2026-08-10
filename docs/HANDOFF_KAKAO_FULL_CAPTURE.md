# 지침 — 카톡 원문 완전 수집 파이프라인 (다른 세션용 자기완결 스펙)

> **이 문서 하나만 보고 시작할 수 있게 작성됨.** 카톡↔MOYI 브릿지가 도는 **별도 PC**에서
> 카톡 원문을 "유의미한 분석용 데이터"로 영구 수집하는 것이 임무. 과거 대화 무시하고 이 문서 기준으로 판단.

---

## 0. 한 줄 임무
카톡 대화 원문을 **절대시각·안정 방ID·메시지ID·발신자**를 갖춘 완전한 형태로 **mindmap-viewer PostgreSQL에 영구 적재**한다. 목적은 분석(거래처 조기경보·의도 모델·수요예측)의 소스를 "최근 5,000개 윈도우"에서 "전체 히스토리"로 승격하는 것.

## 1. 왜 — 현재 소스의 한계 (실측 2026-08-08)
분석이 지금 쓰는 카톡 소스는 **구글시트 '메시지분류' 탭**이고, 세 가지 한계가 있다:
1. **최근 5,000개 윈도우만** — 시트 범위 `A1:Z5000`. 새 메시지 오면 오래된 게 롤오프 → 장기 추세·과거 소급 불가.
2. **절대시각 없음** — 값이 `"오후 8:20"`처럼 날짜 없는 한국어 시각 → `new Date()` NaN. "언제"를 순서로만 추정.
3. **방이름 인코딩 손상** — 같은 방이 U+FFFD로 여러 변형 노드로 쪼개짐(예: '영업방팀 발주…'가 6변형).

또한 PG 복호화 경로(`kakao_messages` 테이블)는 **현재 0건**(상시 적재 미가동). 즉 시트가 유일 소스이고 위 한계를 그대로 안고 있다.

## 2. 확보된 사실 (이 세션이 조사한 것)
- **수집기 저장소**: `github.com/Jayinsightfactory/nenovakakao` (로컬 `C:\Users\USER\nenovakakao`, Python).
- **도는 곳**: 카톡↔MOYI 브릿지가 도는 **별도 PC**(사장님 확인). 이 PC가 카톡 화면을 읽어 원문 텍스트를 이미 확보 중.
- **현재 데이터 흐름**:
  - 카톡 화면 수집(`kakao_explorer*.py`, `core/drawer_handler.py` 등) → 원문 txt
  - `mirror_upload.py` → 카카오워크/MOYI 미러(`{API_BASE}/messages.send`)
  - `core/gsheet_sync.py` → 구글시트 동기화 ← **이게 위 5,000 윈도우 소스**
  - 방이름 매핑: `data/room_mapping.json`
- **핵심**: 수집기는 이미 방·발신자·내용을 원문으로 갖고 있다. **날짜(절대시각)도 카톡 화면의 날짜 구분선에서 복원 가능**(현재 시트 sink가 안 담을 뿐).

## 3. 목표 데이터 스키마 (적재 대상)
mindmap-viewer에 이미 있는 수신 테이블 `kakao_messages` (라우트 `routes/kakao-decrypt.js`)를 재사용. 컬럼:
```
id(메시지 고유·중복방지 키) · chat_id · chatroom(안정 방ID/정규명) · user_id · sender(발신자)
· message(원문) · message_type · source · created_at(★절대시각 ISO)
```
수신 엔드포인트(이미 존재): `POST /api/kakao/import` (배치) / `POST /api/kakao/decrypt`. 스키마·인증은 **작업 시작 시 `routes/kakao-decrypt.js`를 읽어 확정**(엔드포인트 시그니처가 바뀌었을 수 있음).

## 4. 구축 방향 (권장 — 최소 침습)
**기존 시트/미러 파이프라인은 건드리지 말고, 세 번째 sink만 추가한다.**
1. `nenovakakao`에 **PG 적재 sink** 추가 — 수집기가 원문 레코드를 만들 때 `core/gsheet_sync.py`와 같은 지점에서 `POST {MINDMAP_BASE}/api/kakao/import`로도 전송. (`mirror_upload.py`의 `requests.post` 패턴 재사용.)
2. 각 레코드에 반드시 채울 것:
   - **절대시각**: 카톡 화면 날짜 구분선 + "오후 8:20"을 합쳐 ISO(`created_at`)로. 복원 못 하면 수집 시각이라도 넣고 `approx` 플래그.
   - **메시지ID**: (방+발신자+시각+내용) 해시 등 **멱등 키** — 재전송해도 중복 안 되게(서버가 `id`로 upsert).
   - **안정 방ID**: `room_mapping.json`의 정규명 사용(U+FFFD 원본 금지). 서버 `chatroom`에 정규명.
3. 서버측(mindmap-viewer): 필요 시 `kakao-intel-worker.js`가 시트 대신(또는 병행) `kakao_messages`를 소스로 읽도록 스위치 추가 — 단 **기존 시트 경로를 깨지 말 것**(플래그로 병행).

## 5. 선행 조사 스텝 (별도 PC에서, 코드 변경 전)
1. 수집기가 실제로 만드는 레코드 형태 확인: 방·발신자·내용·**시각(날짜 있나)**·ID가 있나. (`kakao_explorer*.py`, `core/gsheet_sync.py` 읽기)
2. `data/room_mapping.json`에 정규 방ID가 있는지, 카톡 원문 방이름과 매핑되는지.
3. 카톡 화면에서 **날짜 구분선**을 수집기가 인식하는지(절대시각 복원 가능성의 핵심).
4. mindmap-viewer `routes/kakao-decrypt.js` 읽고 `/api/kakao/import` 요청 스키마·인증 토큰 확정.

## 6. 검증 (완료 판정)
- `GET /api/kakao/chatrooms` 가 **0 → N방**으로 채워짐.
- `GET /api/kakao/messages?chatroom=…` 의 `created_at`이 **진짜 ISO 타임스탬프**(NaN 아님).
- 같은 배치 재전송 시 **행 수 안 늘어남**(멱등 확인).
- `kakao-intel` 롤업을 이 소스로 돌렸을 때 시트 대비 **더 긴 기간·정확한 타임라인**이 나옴.

## 7. 함정 (반드시 지킬 것)
- **한글 POST 인코딩**: Windows Git Bash raw curl은 한글 바디 손상(실측). Python `requests`(수집기가 이미 사용) 또는 Node `fetch`+`JSON.stringify`로 UTF-8 전송. (메모리 `feedback-curl-korean-utf8-windows`)
- **방이름 정규화**: U+FFFD 원본을 그대로 chat_id로 쓰지 말 것 → 같은 방 쪼개짐 재발. (메모리 `kakao-sheet-ontology-sync`)
- **중복 방지**: 멱등 키 필수. 상시 폴링이면 겹치는 구간 재전송됨.
- **기존 파이프라인 무손상**: 시트 동기화·카카오워크 미러는 그대로. sink 추가만.
- **프라이버시·최소수집**: 업무 방 위주, 파생/분석 목적 명시. 감시 아님(팀 집계·본인 열람 원칙).
- **mindmap-viewer 배포 = push**: 이 저장소는 code-sync가 `git reset --hard origin/main` 주기 실행 → **커밋 즉시 push**. Railway 자동배포가 끊겨 있을 수 있으니 배포 후 `railway deployment list` 최신 SUCCESS 확인(또는 `railway up`). (메모리 `mindmap-viewer-code-sync-wipes-local`)
- **노출 키 주의**: `nenovakakao` 과거 노출키 rotate 이력. 토큰은 env로.

## 8. 관련 포인터
- 저장소: `nenovakakao`(수집기·Python) · `mindmap-viewer`(분석·수신 PG) · `talkhub`/`talkhub-mobile`(MOYI 앱).
- 수신 라우트: `mindmap-viewer/routes/kakao-decrypt.js` (`/api/kakao/import`·`/decrypt`·`/messages`·`/chatrooms`).
- 원문 조회(현 시트 소스): `mindmap-viewer/routes/process-mining.js` `/api/mining/kakao-raw*`.
- 분석 워커: `mindmap-viewer/bin/kakao-intel-worker.js` (소스 스위치 대상).
- 메모리: `kakao-intel-sheet-pipeline` · `kakao-sheet-ontology-sync` · `nenovakakao-workflow-integration` · `nenova-solution-architecture` · `feedback-curl-korean-utf8-windows` · `mindmap-viewer-code-sync-wipes-local`.

## 9. 성공의 정의
"카톡 백업 전체가, 정확한 시각·방·발신자와 함께, 언제든 분석 가능한 형태로 PG에 쌓인다." → 거래처 조기경보·의도 모델·수요예측이 **5,000 윈도우가 아니라 전체 역사**를 근거로 판단하게 된다.
