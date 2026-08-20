# 완전 일일 업무 원장 (Daily Work Ledger) — 설계 스펙

> 2026-08-20 확정. 사장님 요구: "이 사람 메뉴를 열면 아침부터 저녁까지 **모든 업무**를, 각각
> **(내가 직접 할 수 있나 / 이 일을 이해·인수하려면 알아야 할 사람 판단이 뭔가)** 까지 —
> top 1~2~3개가 아니라 **전 직원 전 업무**에 대해." (홀드 해제 후 구현)

## 1. 정의 · 북극성
- **한 줄**: 직원 1명의 하루(출근→퇴근) 화면활동 전체를 **빠짐없이 업무블록으로 분절**하고, 각 블록에
  **① 자동화 판정(내가 대신 가능한가)** + **② 사람 판단 지점(인수/이해하려면 알아야 할 것)** 을 붙인 **인수인계·자동화 원장**. 전 직원.
- **북극성**: 골모드 "AI가 이 일을 직접 할 수 있나" + 인수인계 "배운 적 없어도 이해·수행".

## 2. 세밀분석(deep-dive)과의 차이 — 다른 모드
| | 세밀분석(deepdive) | **일일 원장(ledger, 신규)** |
|---|---|---|
| 창 | 14일 | **하루**(+주/월 롤업) |
| 대상 | top ~10 반복흐름(요약) | **하루 전 업무블록(완전)** |
| 목적 | 자동화 후보 발굴(반복) | **완전 커버리지 + 인수인계** |
| 산출 | workflows[] | blocks[] + coverage |
> 세밀분석=압축(무엇을 자동화). 원장=완전분절(그날 뭘·어떻게·무슨 판단으로, 대신 가능한지).

## 3. 입력
- `GET /api/vision/screen-input?userId&hours=24`(하루) — 시간순 steps{ts,app,screen,inputs[ko],fields[label,value,clickXY]}. **120 cap 제거**(하루 단위라 관리가능).
- 그 시간대 kakao 원문(`/api/kakao/messages`) + ERP 변경(`ops-input.erp`) — 블록 근거 보강.
- 반복 클릭좌표(hotspotsFromScreenInput).
- 전날 원장(자기개선: 확정된 humanJudgment 재사용, 미확정만 재질의).

## 4. 처리 파이프라인
1. **로드 + dedup**: 하루 타임라인 → 빈/단색·중복 프레임 컷(이미 구현).
2. **블록 분절**: 연속 화면을 "하나의 업무" 단위로 절단 — 기준: 앱/화면 전환 + 시간 갭 + 산출물 완성 지점. (개인·휴식·잡담은 '비업무'로 분류, 삭제 아님)
3. **블록별 분류·주석**(LLM): 아래 스키마의 task/steps/**doability**/**humanJudgment**/rule/evidence/blindSpots 생성.
4. **일일 요약 + 커버리지**: 하루 관측시간 대비 업무%·자동화가능%·사람전용%·미분류%, 인수인계 준비도.

## 5. 출력 스키마 — `ops-report` kind=`ledger:<userId>:<YYYY-MM-DD>` (+별칭 `ledger:<userId>`)
```json
{
  "user":"", "userId":"", "date":"2026-08-20", "generatedAtIso":"",
  "workday": { "start":"08:12", "end":"18:40", "activeMin":410, "observedMin":520 },
  "blocks": [{
    "seq":1, "startTs":"", "endTs":"", "durationMin":18,
    "task":"에콰도르 34차 발주 입력", "category":"발주처리",
    "steps":[{"app":"카카오톡","action":"출고수량표 사진 확인","data":"연핑크 30단","evidence":"05:08 사진뷰어"}],
    "output":"주광 발주 시트 확정본",
    "doability": { "verdict":"검토1스텝", "method":"nenoveb기능추가|PAD|Excel|OCR|SOP", "why":"손글씨 판독 1스텝 개입" },
    "humanJudgment": [
      { "point":"색상 품절 시 대체품 선택", "basis":"연노랑 없으면 화이트", "known": true },
      { "point":"통관 손실률 반영 비율",   "basis":"", "known": false }
    ],
    "rule":"출고일·국가별 시트 구획 분리",
    "evidence":"08-12T05:41 Excel K12/O154",
    "blindSpots":["손실률 % 미관측"]
  }],
  "coverage": { "workPct":78, "automatablePct":46, "humanOnlyPct":22, "unclassifiedPct":22 },
  "handoffReadiness": { "score":0.62, "missingJudgments":["손실률 비율","CL코드 정의"] },
  "summary":"오늘 하루 12개 업무블록…"
}
```
**핵심 필드 2개(사장님 강조)**
- `doability` = **"내가 직접 할 수 있나"** — 100%가능/검토1스텝/사람필수 + 방법.
- `humanJudgment[].known` = **"이 판단 기준을 우리가 아는가"** — `false`면 인수인계 사각(=배워야 할 것). 이게 "업무를 보려면 알아야 할 사람 선택".

## 6. 비용 설계 (전 직원×하루×매일 = 무거움 → 반드시)
- 블록당 **1회만**(처리완료 상태 마킹, 재분석 금지) · dedup(구현됨) · 증분(만든 날 스킵).
- 1차 분절·분류 = **Haiku**(저비용), **사람판단 심층추론만 핵심 블록 Sonnet**.
- **야간 배치**(NIGHT) · 5% 일일캡·홀드 준수 · 사용량 가드 통과.
- 하루 타임라인은 dedup 후 블록 ~10~20개 → 직원당 하루 ~15콜 이내 목표.

## 7. 뷰어 — admin 탭 "📒 일일 원장" (public/daily-ledger.html)
- 직원 선택 + **날짜 네비**(◀▶) → 하루 블록 세로 타임라인.
- 블록마다: 시간·업무·앱흐름 + **🤖 자동화 배지**(가능/검토/사람) + **🧠 사람판단 칩**(알면 초록·모르면 빨강=배울것).
- 상단: **커버리지 바**(업무/자동화가능/사람전용/미분류) + **인수인계 준비도**.
- **주/월 롤업**(주기 업무 포착) + 타임테이블(밀도) 시간대 클릭 → 해당 블록 연결.

## 8. 정밀분석 5원칙(+⑥) 준수
엔티티=블록 · 파이프라인=steps · 근거첨부=evidence · 정직한 불확실성=blindSpots/known:false · 자동화지향=doability · ⑥근거계보=sourceType.

## 9. 구현 단계 · 파일
- **P0** `bin/daily-ledger.js` (deep-dive.js 패턴: httpJson·runClaude·ops-report POST). 블록분절 + 주석. `node bin/daily-ledger.js --user <id> --date <YYYY-MM-DD>` / `--all --date`.
- **P1** `public/daily-ledger.html` + admin 탭 배선(iframeMap).
- **P2** 주/월 롤업(저빈도·주기 업무), **미분류(사각) → 세밀분석 자동화후보로 피드백**.
- **P3** `humanJudgment.known=false` → 사장님 확인 큐(1회 확정하면 이후 자동 채움 = 인수인계 지식 축적).

## 10. 의존 · 상한(정직)
엑셀 셀값(수집 배포됨)·clickXY 좌표계·ERP 전량·OCR 노이즈 = 블록 정밀도·doability 신뢰도의 상한. 미확보분은 blindSpots·known:false로 정직 표기. → [[TOTAL_PLATFORM]] P2/P3와 연결.

## 11. 이 원장이 답하는 질문
- "이 직원 하루의 **몇 %가 업무**이고, 그중 **몇 %를 내가 대신** 가능하고, **몇 %는 사람 판단 필수**(그중 몇 개는 우리가 기준을 **모름=배워야**)?" → coverage + handoffReadiness가 정량 답.
- 롱테일/사각/주기 업무 = coverage.unclassified + 주월 롤업으로 발굴.
