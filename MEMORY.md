# PDF OCR MCP Project

## Project Location
- Path: `C:\Users\cando\OneDrive\바탕 화면\ocr 개발\pdf-ocr-mcp`
- Language: TypeScript (Node.js, ESM)
- Run: `npm run dev` or `npx tsx src/server.ts`
- Port: 3001

## Purpose
Invoice PDF → OCR text extraction → visual verification UI → Excel export
Target: 농장/업체별 인보이스 (형식 제각각, ~20 pages)

## Architecture
- **Hybrid OCR**: Tesseract.js (bounding boxes) + Claude Vision (text quality + invoice structure parsing)
- **Digital PDF**: pdf.js-extract for native text coordinates
- **Scanned PDF**: tesseract.js OCR → optional Claude enhancement
- Web UI: Split layout (PDF viewer left + data table right), SVG overlay for bbox visualization
- MCP: Streamable HTTP transport on `/mcp`

## Key Files
- `src/server.ts` - Express + MCP entry point
- `src/pipeline/orchestrator.ts` - Processing pipeline coordinator
- `src/pipeline/invoice-parser.ts` - Claude Vision invoice parsing
- `src/pipeline/bbox-matcher.ts` - Value ↔ bounding box matching
- `src/mcp/tools.ts` - 8 MCP tools
- `ui/index.html` - Single-file web UI
- `src/export/excel-exporter.ts` - ExcelJS export

## Pending (needs sample PDF)
- Excel column structure finalization
- Invoice format adaptation
- Farm/vendor sheet separation decision
