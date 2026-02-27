# Project: my-video (Remotion AI Security YouTube Video)

## Stack
- Remotion 4.0.429, React 19, TypeScript 5.9, Tailwind v4
- `npm run dev` → Remotion Studio (localhost:3000)

## Project Structure
- `src/Composition.tsx` — All 6 scenes + shared components
- `src/Root.tsx` — Composition config (900 frames, 30fps, 1280×720)
- `src/index.ts` — Entry (exports RemotionRoot)
- `src/index.css` — `@import "tailwindcss"`

## Video Spec
- 6 scenes × 150 frames (5s each) = 900 frames total = 30s
- 0.5s (15 frame) fade in/out per scene via `useSceneOpacity()`
- `Sequence` component resets `useCurrentFrame()` to 0 for each scene

## Scene Overview
1. Opening title – dark navy, floating particles, spring scale-in title
2. Threat alert – red theme, pulsing alert bars, THREAT DETECTED label
3. AI network – rotating hex node graph (SVG)
4. Data analysis – animated bar chart, scan line, anomaly detection
5. Security wall – hexagon grid (SVG polygons), spring scale-up from center
6. CTA control room – hologram UI, scan line, 댓글/구독 buttons appear at 2s

## Key Patterns
- `hexPoints(cx, cy, r)` utility for pointy-top SVG hex polygons
- `useSceneOpacity()` custom hook for per-scene fade
- `Avatar` component: holographic humanoid placeholder (replaceable with real image)
- `Subtitle` component: top: 10%, white, 900 weight, gothic font stack
- All animations use `interpolate()` or `spring()` from remotion
