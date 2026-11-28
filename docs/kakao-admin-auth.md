# 카톡 조회 주소 자격 정리 (2026-11-28)

카톡 원문에서 만든 자료를 내보내는 주소 세 개가 **인증 없이 열려 있었다**(2026-11-27 실측). 2026-11-28에 관리자 전용으로 잠갔다.

## 잠근 주소

| 주소 | 내보내는 것 | 이전 | 지금 |
|---|---|---|---|
| `GET /api/admin/kakao-intel` | 거래처 성향·직원 역량·이슈 요약 | 누구나(토큰 없이 200) | 관리자만 |
| `GET /api/kakao/chatrooms` | 채팅방 이름·방마다 글 수·첫/마지막 글 시각 | 누구나 | 관리자만 |
| `GET /api/kakao/stats` | 전체 글 수·발신자별 글 수·일별 추이 | 누구나 | 관리자만 |

이미 예전부터 잠겨 있던 `GET /api/kakao/messages`(2026-09-29)와 같은 규칙을 쓴다. 규칙은 `src/admin-gate.js` 한 곳에 있고, 캡처 썸네일 쪽 `_visionThumbAdminOk`도 같은 것을 쓴다.

## 부를 때 붙일 것

자격은 둘 중 하나로 보낸다. 토큰이 없으면 `401`, 토큰은 있는데 권한이 없으면 `403`이다.

```
Authorization: Bearer <토큰>
```
또는
```
?token=<토큰>
```

통과하는 토큰:

- 마스터 토큰 — 서버 환경변수 `MASTER_TOKEN`
- 관리자 API 토큰 — 서버 환경변수 `ADMIN_TOKENS`, 또는 서버 PC의 `~/.orbit-config.json`에 있는 `token`
- 관리자 이메일 계정의 사용자 토큰 — `ADMIN_EMAILS`(기본 `dlaww584@gmail.com`)로 로그인해 받은 토큰. PG에 백업된 `orbit_...` 열람 토큰도 여기에 해당한다.

일반 직원 계정 토큰으로는 들어갈 수 없다.

`?token=`은 `<img>`나 링크처럼 헤더를 못 붙이는 자리 때문에 남겨 둔 기존 방식이다. 브라우저 화면에서는 `localStorage.orbit_token`을 `Authorization` 헤더로 보내는 쪽을 쓴다(`public/kakao-intel.html` 등).

## 이 주소를 부르는 곳 (2026-11-28 확인)

| 부르는 곳 | 방식 | 지금 상태 |
|---|---|---|
| `public/kakao-intel.html` | `Authorization: Bearer`(localStorage·`?token=`) | 그대로 동작(관리자 토큰일 때) |
| `public/knowledge.html`, `public/admin-analysis.html` | `Authorization: Bearer` | 그대로 동작(관리자 토큰일 때) |
| `bin/kakao-intel-worker.js` | `Bearer` (`~/.orbit-config.json` 토큰) → `/api/kakao/chatrooms` | 그대로 동작 |
| `bin/owner-agent.js`, `bin/xray-worker.js`, `bin/deep-dive.js` | `Bearer` → `/api/admin/kakao-intel` | 그대로 동작 |
| `nenova-hq` `tools/checklist-reporter.cjs` (지휘실 정기 점검) | **헤더 없음** → `/api/kakao/chatrooms`, `/api/admin/kakao-intel` | **인증 실패로 표시된다** |

지휘실 쪽은 `fetchJson(url, { headers: { Authorization: 'Bearer ' + token } })` 한 줄을 붙이고, 토큰은 `~/.orbit-config.json`(사무실 PC에 이미 있다)에서 읽으면 된다. 그 전까지 「카톡 대화 수집」·「카톡 인텔」 두 항목은 「인증 실패」로 뜬다(자료가 틀리게 나오지는 않는다).

## 남긴 것

- `GET /api/kakao/research`는 복호화 시도 횟수·저장 글 수 같은 숫자만 내보내고 대화 내용은 없다. 이번 범위에서 손대지 않았다.
- `routes/kakao-decrypt.js`의 수신 토큰 기본값(`KAKAO_IMPORT_TOKEN_SHA256`)은 해시라 원문은 아니지만, 코드에 기본값이 들어 있다. 회전이 필요하면 따로 결정한다.
