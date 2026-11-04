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

## 콘솔창 깜빡임(conhost) 대응 (2026-11-04 추가)
실측(사장 PC 45초 conhost 86개)의 범인 패턴은 Orbit **분석 워커**를
`cmd.exe /c "node bin/XXX-worker.js > log 2>&1"`로 띄우는 것(부모 ps1은 Hidden이나 손자 cmd가 안 숨겨짐).
- **이 사이드카**: `/target:winexe`(콘솔 없는 서브시스템)로 빌드 → 실행해도 conhost 생성 0. `windowsHide:true`로 spawn.
  실증: 콘솔빌드(/target:exe)는 conhost child=1, winexe는 **0**(기능 정상, perf 라인 유입). PE Subsystem=2 확인.
- **in-repo 런처는 clean**: 데몬 기동/재기동(`guardian-start-daemon.ps1` `& $nodeExe ... 2>&1 |`, `guardian-watchdog.ps1` `Start-Process -WindowStyle Hidden`)은 cmd.exe 미경유. `decode-boost-canary.ps1`/`remote-vision-worker.ps1`은 `& node ... *>> $log`(PS 네이티브). screen-capture execSync 깜빡임은 2026-09-18 선수정됨.
- **로컬 런처 자동 마이그레이션 추가** (`src/daemon-updater.js` `_migrateLauncherNoWindow`, `_postUpdate`에서 호출): 분석 워커 런처(`~/.orbit/*-start.ps1`, `start-daemon.ps1` 제외)의 `& cmd /c "node ... > log 2>&1"` 한 줄을 **cmd 리디렉션(UTF-8 로그 보존)은 유지**하되 `ProcessStartInfo(UseShellExecute=$false, CreateNoWindow=$true)`로 띄우는 블록으로 **치환**. 백업(launcher-backup-auto-*) 후 치환, 이미 CreateNoWindow면 skip(멱등), 매칭 없으면 미수정. 생성 템플릿은 저장소에 없음(로컬 수작업 파일, '생성 주체 미발견') → 업데이트 때마다 이 마이그레이션이 적용.
  - 실증(scratchpad 복사본, 실제 pre-fix 런처 3종+경계케이스): migrated 4 / skip(already·no-cmd) 2 / fail 0, 재실행 멱등(migrated=[]), start-daemon.ps1 이름제외. 치환된 런처 실행 결과 **exit 0, conhost 신규 0**, 로그 UTF-8 `한글OK`(hex ed959c eab880 4f4b) 바이트 보존.
  - **직원 PC 범위**: 코어 데몬(personal-agent.js, 전 PC)은 이 cmd 워커들을 띄우지 않음 — 5개 런처는 사장/분석 PC용. 직원 PC 실제 on-disk 런처 유무는 **미검증**(원격 디스크 확인 안 함) — 있으면 업데이트 시 자동 마이그레이션됨.

## 콘솔창 깜빡임(conhost) 3차: 데몬 런타임 자식 프로세스 (2026-11-04 추가)
런처(2차)가 아니라 **데몬/워커 런타임이 캡처 사이클마다 콘솔앱(powershell)을 스폰**하는 게 진짜 범인(동료 세션 사장 PC 28초 `__InstanceCreationEvent` 추적). 메커니즘은 런처 때와 동일 — 콘솔 없는 부모(windowsHide node)가 콘솔앱을 스폰하면 Windows가 새 conhost를 **강제 할당**해서 `windowsHide:true`/`CREATE_NO_WINDOW`가 신뢰성 있게 창을 못 막는다. 유일한 무창 경로 = 상주 PowerShell 1개(`src/win-shell.js`, 데몬 수명 1개 유지, 이미 bank-mode-toggle/click-rect/clipboard-watcher가 이 경로로 깜빡임 0 달성).
- **`bin/vision-worker.js` `_makeThumb`/`_perceptualHash`**: 캡처당 1회씩 `execSync('powershell … Add-Type System.Drawing …')` 호출 → win-shell 경로로 전환(두 함수 async화, 호출부 6곳 `await`). `ws.isAvailable()==false`(비Windows/상주셸 실패) 때만 기존 execSync 폴백(비Windows라 창 문제 없음).
- **`src/egress-monitor.js` `ps()`**: 인쇄 폴러 5초·LogicalDisk·DiskDrive 등 `execFile('powershell …')` 단일 초크포인트 → 동일하게 win-shell 경로 전환, 폴백만 execFile. win-shell은 spawn 시 OutputEncoding=UTF8 설정이라 한글 프린터명·사용자명 보존.
- **실증(scratchpad, `__InstanceCreationEvent` 외부 watcher)**: _makeThumb+_perceptualHash 실제 PS 스크립트를 6 캡처사이클(PS 12회) 돌려 conhost/cmd/powershell 신규 생성 집계 — **win-shell 경로=0**, 대조 execSync 경로=18(샘플에 `cmd.exe ppid=<node>` 확인=깜빡임 원인). perceptual hash 64bit 출력 정상(hashOk=true). jest 240 PASS(회귀 없음).

## 콘솔창 깜빡임(conhost) 4차: 런타임 콘솔 스폰 전수 조사 + 핫패스 추가 제거 (2026-11-04)
동료 세션 사장 PC 재추적으로 3차(vision-worker/egress)로도 안 끝나는 소스들 확인. 전수 조사 결과와 처리:

**이번에 win-shell로 전환(실증 완료):**
- **`src/ocr-triage.js` `ocrExtract`**(핫패스, 캡처당 1회, `VISION_OCR_TRIAGE=on/shadow`일 때) — `execFileSync('powershell -File ocr-extract.ps1')` → 상주 win-shell `& ocr-extract.ps1`. 호출부 async화(`bin/vision-worker.js:591`, `scripts/ocr-triage-measure.js` await). `setup/ocr-extract.ps1`의 `exit 0`→`return`(상주 셸을 죽이지 않게, `-File` 모드도 정상 종료). 비Windows/상주셸 실패 시만 execFileSync 폴백.
- **`src/self-healer.js`** 주기 점검의 `tasklist`(powershell 수/python 수)·`(Get-PSDrive C).Free`·python kill → win-shell `Get-Process`/`Stop-Process`. 실패 시 tasklist/taskkill 폴백 유지.

**조사 후 '이번 미전환'(사유 명시):**
- **`src/secure-collector.js`** — `_getStatus()`가 **1초마다** `execSync(powershell -File …)` 스폰(실측 확인, 코드에 `_shouldSkipForBusy`='창 깜빡임 방지' 주석 존재) = 최악의 잔존 소스. **단, 은행보안 훅차단 PC에서만 실행**(소수, 예: 박성수 DESKTOP-HGNEA1S). 1초 핫루프 + 멀티모드 `.ps1`(exit 포함 가능) 전환은 코어 은행우회 수집기 리그레션 위험 커서 **별도 전용 패스+은행모드 PC 검증 필요**. → **잔존 1순위.**
- **`src/screen-capture.js:959`** — PowerShell CopyFromScreen은 **3순위 최후수단 폴백**(PIL·pyautogui 둘 다 실패=python 없는 PC). 실측 미포착. 동기 capture() 경로라 async 전환 ripple. → 폴백 PC에서만 발생(**미검증**).
- **`bin/claude-reaper.js:28`** — owner PC 전용 독립 프로세스(120초), 조건부 `taskkill /T`(트리킬). win-shell 등가 대체 까다로움. → owner 전용·저빈도.

**조사 결과 '해당 없음'(안 돎):**
- **`src/keylogger.js:136`** — **미사용(dead)**: 저장소 어디서도 `require` 안 함(데몬은 `keyboard-watcher.js` 사용). 실행 경로 아님 → 전환 불필요. 프라이버시 헌법상 keylogger는 비활성 유지.
- **`src/system-monitor.js:186`** — 데몬 기동 경로에 없음. `orbit-client.js`/`server.js`(Railway Linux)만 require → 직원 PC 데몬 깜빡임 원인 아님(Windows 분기 안 탐).

**실증(`__InstanceCreationEvent` 외부 watcher, ppid 귀속)**: 실제 `ocr-triage.ocrExtract()` 6회 — **win-shell 경로 우리프로세스 신규 스폰=0**(전체 0), OCR 정상(ok=true, 'ORBIT 12345'→2단어 인식), 상주셸 생존(isAvailable=true, probe=2 → exit→return 확인). 대조 폴백(execFileSync -File)=우리프로세스 powershell 6회(+conhost 다수). jest 240 PASS.

## 미검증 / 잔존 위험
- **배포 안 함.** 직원 PC 실배포·원격명령 미실시. push≠데몬반영(재시작 전까지 구코드).
- **AhnLab V3/Defender**: `~/.orbit/bin`에 런타임 생성된 x86 exe(SetWinEventHook 사용)를 백신이 격리할 가능성. 기존 AV 자가예외 경로가 커버하는지 실배포에서 확인 필요(현재 미검증). 격리되면 state='disabled'로 떨어져 데몬엔 무해.
- **csc 부재 PC**: .NET Framework 4 csc가 없으면 컴파일 불가 → state='disabled'(데몬 무영향). Win10/11엔 거의 상존하나 전수 미확인.
- **전체 주문입력 end-to-end(저장 대화상자까지)**: DB 쓰기 금지라 실 nenova에서 저장을 눌러 재현하지 않음. 저장/성공대화상자 캡쳐는 2026-11-04 프로토타입 스파이크(SPIKE-RESULT.txt, events 545/named 494)에서 이미 실증됨 — 본 상용 빌드는 동일 기법.
- **서버측 소비/스티칭**(work.action → 절차 재구성)은 이 작업 범위 밖(다음 단계).
