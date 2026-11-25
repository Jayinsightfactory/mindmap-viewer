# `rust-collector` (`orbit-collector-rs` v0.2.0)

Phase 1 카나리 1대 Opt-in 전용 Rust 수집기 사이드카 소스입니다. 바이너리(`.exe`)와 빌드 산출물(`target/`)은 `.gitignore` 처리되어 저장소에 커밋되지 않습니다.

## 1. 파일럿 대비 4대 프로덕션 보강 사항
1. **네이티브 HTTPS/TLS (`src/http_client.rs`)**: Windows `winhttp.dll` 동적 FFI(`WINHTTP_FLAG_SECURE`)로 외부 크레이트/OpenSSL 없이 Railway HTTPS(`https://mindmap-viewer-production-adb2.up.railway.app`) 전송 지원.
2. **유효한 RFC3339/ISO8601 UTC (`src/iso_time.rs`)**: `now_iso()`를 epoch ms 대신 `YYYY-MM-DDTHH:MM:SS.sssZ`로 생성해 `/api/vision/spool` 및 `/api/hook` 서버 스키마와 완전 정합.
3. **정직한 스풀 릴레이·유한 링버퍼·내장 프라이버시 게이트 (`src/privacy.rs`, `src/ring_buffer.rs`, `src/win_capture.rs`)**:
   - 가짜 `kb_data()`/`mouse_data()` 합성 스텁 완전 제거.
   - 금융/은행/보안 프로세스·창(`TouchEn`, `nProtect`, `ASTx`, `INISAFE`, 인터넷뱅킹, 공동인증서, 비밀번호 등)·개인 웹·비업무 메신저 및 `~/.orbit/personal-pause-until` 차단 내장.
   - 오프라인 재전송 큐를 유한 JSONL 링버퍼(`buffer-rs/events.jsonl`, 기본 최대 1,000건 / 4MB)로 교체해 디스크 무한 적체 차단.
4. **무부작용 카나리 검증 플래그 (`--dry-run`, `--self-test`, `--probe-health <url>`)**: 서버 쓰기/마커 변경 없이 스풀·링버퍼·프라이버시·TLS 검증 가능.

## 2. 로컬 릴리스 빌드 (worktree 외부 `CARGO_TARGET_DIR` 권장)

```powershell
$env:CARGO_TARGET_DIR = 'E:\AI-Work\rust-pilot\target-phase1'
cargo test --manifest-path .\rust-collector\Cargo.toml
cargo build --release --manifest-path .\rust-collector\Cargo.toml
```

생성된 바이너리 검증:

```powershell
E:\AI-Work\rust-pilot\target-phase1\release\orbit-collector-rs.exe --self-test --probe-health https://mindmap-viewer-production-adb2.up.railway.app
```

## 3. 카나리 1대 Opt-in 적용 절차 (전 직원 기본 OFF)

기존 전 직원 PC는 `rustCollector` 미설정 상태이므로 100% 기존 Node(`src/screen-capture.js`, `daemon/local-buffer.js`) 경로가 무변형 유지됩니다. 카나리 1대에만 수동 적용합니다(전 직원 원격배포 금지):

```powershell
# 1) 바이너리 배치 (카나리 1대 PC)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.orbit\bin" | Out-Null
Copy-Item "E:\AI-Work\rust-pilot\target-phase1\release\orbit-collector-rs.exe" "$env:USERPROFILE\.orbit\bin\orbit-collector-rs.exe" -Force

# 2) 무부작용 사전 점검
& "$env:USERPROFILE\.orbit\bin\orbit-collector-rs.exe" --self-test

# 3) 카나리 1대 Opt-in 실행 (환경변수 OR ~/.orbit-config.json {"rustCollector": true})
$env:ORBIT_RUST_COLLECTOR = '1'
node .\daemon\personal-agent.js
```

롤백(즉시 Node 복귀): `$env:ORBIT_RUST_COLLECTOR = '0'` 제거 또는 `~/.orbit-config.json`에서 `"rustCollector": false` 설정. 또한 5분 내 3회 이상 크래시/스폰 실패 시 `src/rust-collector-sidecar.js` 서킷브레이커가 세션 동안 자동 발동해 즉시 Node `screen-capture.js`/`local-buffer.js`로 폴백합니다.

## 4. 전후 실측 벤치마크 (2026-11-25, Windows x64)

| 항목 | Node.js 기준 (전) | Rust `orbit-collector-rs.exe` (후) | 비고 |
|---|---|---|---|
| 실행 바이너리/런타임 크기 | `88.0 MB` (`node.exe`) | `474.0 KB` (`485,376 B`) | 단일 정적 `.exe`, 외부 크레이트 0 |
| 유휴 메모리 (WorkingSet) | `55.63 MB` (빈 Node 기준) | `3.96 MB` (`--dry-run` 상주) | 유휴 RAM 92.9% 절감 |
| `--self-test` 콜드스타트 | — | `126.3 ms` (PASS) | ISO8601·Privacy·RingBuffer·WinHTTP TLS |
| Railway HTTPS `/health` 프로브 | — | HTTP `200` (`winhttp-native-tls`) | 실서버 TLS 핸드셰이크 통과 |
| 로컬 스풀 50장(200KB×50) | `261.6 ms` (`191.1 files/s`, keep-alive) | `1,192.0 ms` (`41.9 files/s`, 요청당 WinHTTP) | 50/50 성공, 90초당 30장 배치 충분 |
