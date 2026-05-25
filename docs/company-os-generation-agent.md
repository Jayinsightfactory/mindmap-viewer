# Nenova Company OS Generation Agent

Date: 2026-05-25 KST

## Stage

This is a structure-only agent. It does not provide employee-facing features,
does not queue daemon commands, and does not generate scripts for employee PCs.

The purpose is to decide whether a future system can outperform the existing
`nenova.exe` and Nenova Web flows before anything is shipped.

## What It Must Understand

- `nenova.exe` work evidence from employee PCs.
- Nenova Web UI structure and testability.
- KakaoTalk/KakaoWork conversation evidence.
- Vision/OCR screen understanding.
- Mouse/keyboard traces and learned GUI targets.
- Work Unit, cross-validation, outcome, and algorithm learning contracts.
- The user's planning documents and new product direction.

## Capability Model

The test model scores five capabilities:

| Capability | Meaning |
| --- | --- |
| OCR / Vision Text | Can the system read screen text, fields, tables, and state? |
| Claude in Chrome | Can browser workflows be understood without turning them into unsafe automation? |
| Native GUI Understanding | Can Nenova.exe, Excel, and KakaoTalk controls be identified reliably? |
| Nenova Web / Playwright | Can the web UI be tested and replayed separately from employee PCs? |
| Computer Use Orchestrator | Can perception, target selection, action plan, verification, and rollback be judged together? |

## Promotion Gate

A capability is not employee-facing until it passes:

- readiness score >= 0.85,
- perception score >= 0.80,
- targeting score >= 0.80,
- verification score >= 0.80,
- at least 50 replay/evidence cases,
- baseline comparison against `nenova.exe` and Nenova Web.

## API

Read-only and simulation-only endpoints:

- `GET /api/company-os-generator/capabilities`
- `GET /api/company-os-generator/workspace-map`
- `GET /api/company-os-generator/evaluate`
- `POST /api/company-os-generator/simulate`

These endpoints are for internal evaluation. They must not be treated as
deployment or employee support features.

## Product Direction

The generated system should become a Korean SME company OS:

1. Evidence Fusion: collect and normalize PC, Kakao, ERP, Vision evidence.
2. Unified Operation UI: operate the company from one work graph.
3. Agent Algorithm Development: improve interpretation and assistance quality.
4. Computer Use Lab: prove OCR, GUI, Chrome, Playwright, Computer Use readiness.
5. Commercial Proof: sell accuracy, time saved, and operational reliability.
