# Nenova Computer Use Lab

Date: 2026-05-25 KST

`scripts/nenova-cu.js` is a local terminal tool for Nenova-focused computer use.
It combines OCR, desktop GUI inspection, Playwright web automation, planning,
and GitHub reference ingestion.

## Commands

```bash
node scripts/nenova-cu.js health
node scripts/nenova-cu.js capture
node scripts/nenova-cu.js ocr --image artifacts/nenova-cu/screen.png --engine best
node scripts/nenova-cu.js gui
node scripts/nenova-cu.js desktop-run --click "100,200"
node scripts/nenova-cu.js desktop-run --click "100,200" --type "TEST" --execute
node scripts/nenova-cu.js preview
node scripts/nenova-cu.js web-audit http://localhost:4747/orbit3d.html
node scripts/nenova-cu.js web-run http://localhost:4747 --click "text=Login"
node scripts/nenova-cu.js plan --goal "주문 입력 업무 확인" --url http://localhost:4747
node scripts/nenova-cu.js learn-github
```

## OCR Upgrade

`ocr --engine best` tries stronger engines first:

1. Claude Vision through Claude CLI, when authenticated.
2. Tesseract, when installed.
3. Windows OCR fallback.

After raw OCR, the tool applies Nenova-specific post-processing:

- corrects common Korean business OCR mistakes,
- extracts `거래처`, `주문번호`, `품목`, `수량`, `날짜`, `금액`,
- infers work screen type such as order, shipment, purchase, inventory, or Kakao,
- extracts candidate line items from product/quantity-like lines.

Output JSON includes both `rawText` and corrected `text`.

## Visual Preview

`preview` creates:

```text
artifacts/nenova-cu/preview.html
```

The preview replays recent artifacts like a video timeline:

- click points from `desktop-run`,
- typed/hotkey actions,
- OCR word boxes from OCR engines that provide coordinates,
- web element boxes from Playwright audits,
- before/after screenshots for executed desktop actions.

## GitHub References

The default ingestion reads public README/reference material from:

- `microsoft/playwright`
- `pywinauto/pywinauto`
- `microsoft/OmniParser`
- `OpenAdaptAI/OpenAdapt`

The result is stored in:

```text
artifacts/nenova-cu/github-patterns.json
```

This is reference ingestion, not model-weight training.

## Safety Boundary

- Native desktop GUI is dry-run unless `--execute` is passed.
- Employee daemon command queues are not used.
- Browser actions run only when `web-run` is explicitly called.
- Output artifacts are written under `artifacts/nenova-cu`.
