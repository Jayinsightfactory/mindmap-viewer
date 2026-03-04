# PDF OCR MCP 서버 구현 계획 (인보이스 → Excel)

## Context
**목적**: 농장/업체별 인보이스 PDF (20페이지 분량, 형식 제각각)에서 업체명, 품목, 수량, 단가 등을 OCR 추출하여 Excel로 내보내기. 수치 오류 방지를 위해 추출된 값이 PDF 원본의 어느 위치에서 나왔는지 1:1로 시각적 마킹하여 웹 브라우저에서 빠르게 눈으로 검증/수정 가능해야 함.

## 사용 시나리오
```
1. PDF 업로드
2. 각 페이지 자동 OCR → 인보이스 테이블 데이터 추출 (업체, 품목, 수량, 단가, 금액)
3. 왼쪽: PDF 원본 이미지 + 추출 위치 바운딩박스 마킹
   오른쪽: 추출된 데이터 테이블 (수정 가능)
4. 테이블의 셀에 마우스 올리면 → PDF 원본의 해당 위치가 하이라이트
5. 값이 틀리면 테이블에서 직접 수정
6. 모든 페이지 확인 완료 → Excel 다운로드
```

## 미확정 사항 (내일 샘플 PDF 업로드 후 확정)
- [ ] Excel 컬럼 구조 (업체 | 품목 | 수량 | 단가 | 금액 등)
- [ ] 기존 Excel 템플릿 여부 및 형식
- [ ] 인보이스 형식 샘플 (형식이 제각각이므로 실물 확인 필요)
- [ ] 농장별 시트 분리 여부

---

## 핵심 설계 결정

### 텍스트 위치 추출 전략 (Hybrid 방식)
- Claude Vision API는 바운딩 박스 좌표를 반환하지 않음 (좌표 요청 시 부정확한 값 생성)
- **디지털 PDF**: `pdf.js-extract`로 네이티브 텍스트 좌표 추출 (정확도 100%)
- **스캔 PDF**: `tesseract.js`로 단어별 바운딩 박스 추출 → Claude Vision으로 텍스트 품질 개선
- **핵심**: Tesseract = 좌표 담당, Claude Vision = 텍스트 정확도 + 구조 파싱 담당

### 인보이스 구조 파싱 전략
- Claude Vision에 페이지 이미지를 보내서 **구조화된 데이터** 추출 (업체명, 품목, 수량, 단가, 금액)
- 추출된 각 값을 Tesseract/pdf.js의 바운딩 박스와 **매칭** → 원본 위치 연결
- 형식이 제각각이어도 Claude가 문맥으로 파악 가능

### 기술 스택
- TypeScript + Node.js
- Express (웹 서버 + REST API)
- MCP SDK (Streamable HTTP transport)
- pdf-to-img (PDF → 이미지 변환)
- pdf.js-extract (디지털 PDF 텍스트 좌표 추출)
- tesseract.js (스캔 PDF OCR + 바운딩 박스)
- @anthropic-ai/sdk (Claude Vision: 텍스트 품질 + 구조 파싱)
- exceljs (Excel 파일 생성/내보내기)
- SVG 오버레이 (바운딩 박스 시각화)

---

## 프로젝트 구조

```
pdf-ocr-mcp/
  package.json
  tsconfig.json
  src/
    server.ts                    # Express + MCP 서버 진입점
    mcp/
      tools.ts                   # MCP 도구 정의
    pipeline/
      pdf-converter.ts           # PDF → PNG 이미지 변환
      pdf-classifier.ts          # 디지털 vs 스캔 판별
      text-extractor-digital.ts  # pdf.js-extract 텍스트 추출
      text-extractor-scanned.ts  # tesseract.js OCR
      claude-enhancer.ts         # Claude Vision 텍스트 품질 개선
      invoice-parser.ts          # Claude Vision 인보이스 구조 파싱
      bbox-matcher.ts            # 추출값 ↔ 바운딩박스 매칭
      orchestrator.ts            # 파이프라인 통합 조율
    storage/
      types.ts                   # 핵심 데이터 타입
      document-store.ts          # 문서 상태 관리 (인메모리)
    export/
      excel-exporter.ts          # Excel 파일 생성 (exceljs)
    web/
      routes.ts                  # REST API 라우트
  ui/
    index.html                   # 웹 뷰어 UI (단일 파일)
```

---

## MCP 도구

| 도구 | 설명 |
|------|------|
| `upload_pdf` | PDF 파일 업로드 (base64) → documentId 반환 |
| `get_status` | 문서 처리 상태 조회 |
| `extract_page` | 특정 페이지 OCR + 인보이스 데이터 추출 |
| `get_page_image` | 페이지 이미지 base64 반환 |
| `search_text` | 전체 문서 텍스트 검색 |
| `edit_text` | 특정 텍스트/값 수정 |
| `export_excel` | 확인된 데이터를 Excel로 내보내기 |
| `open_viewer` | 웹 브라우저 뷰어 열기 (URL 반환) |

---

## 처리 파이프라인

```
PDF 업로드
  ↓
페이지별 이미지 변환 (pdf-to-img, 2x 해상도)
  ↓
디지털/스캔 판별
  ↓
┌─ 디지털 PDF: pdf.js-extract → 텍스트 + 좌표
└─ 스캔 PDF: tesseract.js → 텍스트 + 바운딩박스
  ↓
Claude Vision → 인보이스 구조 파싱
  (업체명, 품목, 수량, 단가, 금액을 JSON으로 추출)
  ↓
bbox-matcher: 추출된 각 값 ↔ OCR 바운딩박스 매칭
  (fuzzy string matching으로 값의 원본 위치 연결)
  ↓
PageData 저장 {
  이미지,
  TextBlock[] (전체 OCR 결과 + bbox),
  InvoiceRow[] (구조화 데이터 + 각 필드의 bbox 참조)
}
```

---

## 웹 UI 구조 (좌우 분할 레이아웃)

```
┌──────────────────────────────────────────────────────────────┐
│  Invoice OCR Viewer    [파일 업로드]  [Excel 다운로드]          │
├─────────────────────────────┬────────────────────────────────┤
│  PDF 원본 뷰어 (왼쪽)        │  추출 데이터 테이블 (오른쪽)      │
│                             │                                │
│  ┌───────────────────┐      │  페이지 3 데이터:                │
│  │ PDF 페이지 이미지   │      │  ┌──────┬────┬───┬────┬────┐  │
│  │ + SVG 바운딩박스    │      │  │업체  │품목│수량│단가 │금액 │  │
│  │                   │      │  ├──────┼────┼───┼────┼────┤  │
│  │ [파란박스]=텍스트   │      │  │A농장 │사과│100│500 │50K │  │
│  │ [빨간박스]=현재선택  │      │  │A농장 │배 │ 50│800 │40K │  │
│  │ [노란박스]=검색매칭  │      │  │B농장 │감 │200│300 │60K │  │
│  │                   │      │  └──────┴────┴───┴────┴────┘  │
│  └───────────────────┘      │                                │
│                             │  셀 클릭 → PDF 해당 위치 하이라이트│
│                             │  셀 더블클릭 → 값 수정             │
│  [◀ 이전] 3/15 [다음 ▶]     │                                │
├─────────────────────────────┴────────────────────────────────┤
│  검색: [________________] [검색]                               │
│  전체 문서 통계: 15업체, 248품목, 총 ₩12,500,000               │
└──────────────────────────────────────────────────────────────┘
```

### UI 인터랙션
- **테이블 셀 호버** → 왼쪽 PDF 뷰어에서 해당 값의 원본 위치가 빨간 박스로 하이라이트
- **테이블 셀 더블클릭** → 인라인 편집 모드, 값 수정 가능
- **PDF 바운딩박스 클릭** → 오른쪽 테이블에서 해당 행/셀 하이라이트
- **양방향 연결**: 테이블 ↔ PDF 원본 위치가 실시간으로 연동

---

## 구현 순서

### Phase 1: 프로젝트 기반
1. npm init, TypeScript, Express 세팅
2. 핵심 데이터 타입 정의 (`types.ts`)
3. DocumentStore 구현 (인메모리)

### Phase 2: PDF 처리 파이프라인
4. pdf-converter (pdf-to-img)
5. pdf-classifier (디지털/스캔 판별)
6. text-extractor-digital (pdf.js-extract)
7. text-extractor-scanned (tesseract.js)
8. claude-enhancer (Claude Vision 텍스트 품질)
9. invoice-parser (Claude Vision 구조 파싱)
10. bbox-matcher (값 ↔ 좌표 매칭)
11. orchestrator (파이프라인 통합)

### Phase 3: MCP 서버
12. MCP 도구 등록
13. Express 서버 + MCP Streamable HTTP endpoint
14. REST API 라우트

### Phase 4: 웹 UI
15. 좌우 분할 레이아웃 (PDF 뷰어 + 데이터 테이블)
16. SVG 오버레이 + 양방향 하이라이트 연동
17. 인라인 셀 편집
18. 파일 업로드 + 페이지 네비게이션
19. 검색 기능

### Phase 5: Excel 내보내기
20. exceljs로 Excel 생성
21. 컬럼 구조 (샘플 PDF 확인 후 확정)
22. 다운로드 기능

### Phase 6: 통합 테스트
23. 실제 인보이스 PDF로 E2E 테스트
24. Claude Code MCP 연동 테스트

---

## 검증 방법
1. `npm run dev`로 서버 시작
2. 브라우저에서 `http://localhost:3001` 접속
3. 인보이스 PDF 업로드 → 페이지 이미지 + 추출 테이블 표시
4. 테이블 셀 호버 → PDF 원본 해당 위치 하이라이트 확인
5. 수치 정확성 눈으로 검증
6. 틀린 값 수정 → Excel 다운로드
7. Claude Code에서 MCP 도구 호출 테스트
