# nenova 행동순서 캡쳐 사이드카 + 성능 자기점검

작성 2026-11-04. 브랜치 `claude/orbit-workflow-capture-570204`. **배포 안 함 — 코드 변경 + 로컬 검증까지만.**

## 왜 만들었나
nenova.exe(DevExpress WinForms, 공유 MSSQL ERP 클라이언트)는 DB에 '누가/무엇을/언제 바꿨다'
결과만 남고 '어떤 버튼을 어떤 순서로 눌렀는지'는 어디에도 없다. 기존 Orbit 데몬의
`uia-recorder.ps1`은 UIA `FocusedElement`를 250ms 폴링해서 `work.step`을 만들지만,
**버튼 클릭 순서**와 **성공/실패 대화상자 메시지**(예: "주문이 정상적으로 등록되었습니다")를 놓친다.
이 모듈은 그 공백만 메우는 **추가·격리** 모듈이다. 기존 수집/업로드 코드는 수정하지 않았다.

## 구성 (추가만, 기존 미수정)
| 파일 | 역할 |
|------|------|
| `src/win-action-spy.cs` | 네이티브 사이드카 소스. x86 + `[STAThread]` + 수동 메시지펌프 + `SetWinEventHook`(OUTOFCONTEXT 전역훅). `get_accName`/`get_accRole`만 호출(값 미수집). 읽기전용·EXE/DB 무접촉. |
| `src/work-action-recorder.js` | 데몬이 로드. 첫 기동 때 `csc`로 x86 컴파일(`~/.orbit/bin/win-action-spy.exe`), spawn·감시·재기동, JSONL tail → `work.action` 배치 업로드. 실패 격리. |
| `src/perf-selfcheck.js` | 데몬·사이드카 CPU/메모리 자기측정, '느림이 우리 탓이냐' 판정+자동 스로틀, 업데이트 전/후 성능 게이트. |
| `daemon/personal-agent.js` | 두 모듈을 try/catch로 기동, `_reportBatch` 헬퍼, heartbeat `workAction`/`perf` 필드, shutdown 정리. |

## 검증된 캡쳐 기법 (재발명 금지)
`SetWinEventHook`(0x0003~0x0006, 0x8002~0x8013) 전역훅 + 콜백 내 `AccessibleObjectFromEvent`
→ 타입지정 `Accessibility.IAccessible.get_accName/get_accRole`. **x86 빌드 + [STAThread] +
PeekMessage/Translate/Dispatch 수동 펌프**라야 콜백이 온다. anycpu/`Application.Run`/late-bound는 콜백 0건.
컴파일: `csc /nologo /noconfig /platform:x86 /target:exe /reference:System.dll /reference:System.Core.dll /reference:<Framework>\Accessibility.dll`.
(GAC/PowerShell 중복 interop 에러 회피 위해 `/noconfig` + 프레임워크 Accessibility.dll 명시.)

## 개인정보 원칙 (orbit 헌법 준수)
- 기록 주어 = 업무 절차(폼→컨트롤 역할+이름→액션→순서+시각). 사람은 Windows 사용자 슬롯 하나.
- **`get_accValue` 미호출** → 타이핑 값/그리드 셀 내용/자유 텍스트를 구조적으로 수집 불가.
  WinForms accName은 컨트롤 라벨이지 입력 내용이 아님. DevExpress 셀은 'Editing control'만 줘서 자동 제외.
- `win`(GetWindowTextW) 필드는 자식 hwnd에서 깨진 문자열이라 **기록하지 않음**. 화면 맥락은 직전 FOREGROUND로 복원.
- 직원 노출 문구에 감시/추적/모니터링 어휘 없음(업무지원·절차학습). privacy-notice.txt 갱신.

## 노이즈 필터
버림: 이름 없음, '스크롤 화살표', 'Editing control', 레이아웃창 FOREGROUND(Vertical/Horizontal/MainView/
layoutControl2/Form1/한글자제목), 연속 중복(같은 폼+역할+이름+액션 300ms). 남김: 명명된 폼 FOREGROUND,
버튼 FOCUS/STATECHANGE, 메뉴, 대화상자 메시지.

## 성능 자기점검
- **CPU 자기측정**: 데몬 `process.cpuUsage` 델타 / 사이드카 네이티브 `__perf` JSONL(cpuPct·wsMB·hooked).
- **느림 판정**: 우리 두 프로세스 CPU 합 vs 시스템 전체(resource-governor 값 재사용). 우리≥25% OR (시스템≥75%·우리비중≥50%) 2틱 → 사이드카 pause(control 파일) + `daemon.perf.alert`. ≤12%면 재개.
- **업데이트 게이트**: 코드세대별 정상상태 스냅샷을 `~/.orbit/perf-baseline.json`에 남겨 업데이트마다 전/후 CPU·RSS·핸들·사이드카WS 비교 → 회귀면 `daemon.perf.gate`. 재시작을 자연히 가로질러 측정.

## 로컬 실증 (2026-11-04, 실 nenova pid 14908 읽기전용, 창 활성화만·클릭 無·DB 쓰기 無)
```
work.action FOCUS/FOREGROUND  window '화훼 관리 프로그램 v1.0.15'
work.action FOCUS             window '견적서 관리'
work.action FOCUS             btn    '새로고침'
```
- 이름·역할·순서·시각 포착, pid 필터 targets=1(nenova만), 노이즈 104→6 / 17→16.
- `__perf`: cpuPct 10.85(워밍업)→0.04(정상), wsMB 19~22, hooked true→(pause)false→(run)true.
- **스로틀**: control 파일 pause→네이티브 훅 해제, run→재부착 확인.
- **고아 방지**: 부모 프로세스 kill 후 ~4초 내 사이드카 자동 종료 확인.
- **Node 감시자 통합**: 모듈이 exe 컴파일→spawn(pid)→tail→`work.action` 배치 report(sent=2)→getStatus→stop 전 과정 동작.
- **추가성**: 기존 jest 단위 테스트 239개 PASS. `/api/hook`은 type 화이트리스트 없음·NOISE 아님 → work.action 저장됨.

## 미검증 / 잔존 위험
- **배포 안 함.** 직원 PC 실배포·원격명령 미실시. push≠데몬반영(재시작 전까지 구코드).
- **AhnLab V3/Defender**: `~/.orbit/bin`에 런타임 생성된 x86 exe(SetWinEventHook 사용)를 백신이 격리할 가능성. 기존 AV 자가예외 경로가 커버하는지 실배포에서 확인 필요(현재 미검증). 격리되면 state='disabled'로 떨어져 데몬엔 무해.
- **csc 부재 PC**: .NET Framework 4 csc가 없으면 컴파일 불가 → state='disabled'(데몬 무영향). Win10/11엔 거의 상존하나 전수 미확인.
- **전체 주문입력 end-to-end(저장 대화상자까지)**: DB 쓰기 금지라 실 nenova에서 저장을 눌러 재현하지 않음. 저장/성공대화상자 캡쳐는 2026-11-04 프로토타입 스파이크(SPIKE-RESULT.txt, events 545/named 494)에서 이미 실증됨 — 본 상용 빌드는 동일 기법.
- **서버측 소비/스티칭**(work.action → 절차 재구성)은 이 작업 범위 밖(다음 단계).
