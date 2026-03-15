"""
analyzer/task_classifier.py
Haiku 기반 작업 분류 + 작업 그래프 생성

역할:
  1. 원시 이벤트 배치 → 업무/비업무 분류
  2. 업무 이벤트 → 작업 단위(Task) 클러스터링
  3. 작업 그래프 생성 (어떤 순서로 어떤 앱에서 작업하는지)
  4. 반복 패턴 감지
  5. 자동화 가능성 평가

비용 최적화:
  - 배치 처리 (1시간 분량을 한 번에 분석)
  - 짧은 프롬프트 + structured output
  - 비업무 데이터 사전 필터링
"""
import json
import logging
from datetime import datetime

logger = logging.getLogger('orbit.classifier')

# ── 사전 필터: Haiku 호출 전 비업무 제거 ──────────────────────
NON_WORK_APPS = {
    'spotify', 'music', 'vlc', 'netflix', 'youtube',
    'steam', 'game', 'kakaotalk',  # 개인 메신저는 제외 가능
}

NON_WORK_TITLES = [
    'netflix', 'youtube - ', 'twitch', 'game',
    'spotify', 'apple music',
]


def pre_filter(events):
    """Haiku 호출 전 명백한 비업무 이벤트 제거"""
    filtered = []
    for e in events:
        app = (e.get('app') or '').lower()
        title = (e.get('title') or '').lower()

        if app in NON_WORK_APPS:
            continue
        if any(kw in title for kw in NON_WORK_TITLES):
            continue
        filtered.append(e)

    removed = len(events) - len(filtered)
    if removed:
        logger.debug(f"사전 필터: {removed}개 비업무 이벤트 제거")
    return filtered


def build_analysis_prompt(events_summary):
    """Haiku에게 보낼 분석 프롬프트 생성"""
    return f"""당신은 직원 업무 분석 AI입니다. 아래 작업 데이터를 분석하세요.

## 분석 데이터
{events_summary}

## 요청
다음 JSON 형식으로 응답하세요:

```json
{{
  "tasks": [
    {{
      "task_name": "작업명 (구체적으로)",
      "category": "문서작성|스프레드시트|이메일|커뮤니케이션|개발|디자인|데이터분석|회의|기타",
      "apps_used": ["사용한 앱 목록"],
      "steps": ["단계1", "단계2", ...],
      "duration_min": 예상소요시간(분),
      "data_flow": "앱A → 앱B → 앱C (데이터 이동 흐름)",
      "automation_score": 0.0~1.0,
      "automation_method": "자동화 방법 설명 (가능한 경우)",
      "is_repetitive": true/false,
      "frequency_guess": "매일|매주|매월|비정기"
    }}
  ],
  "work_pattern": {{
    "primary_tools": ["가장 많이 쓰는 앱"],
    "bottleneck": "가장 시간이 많이 드는 작업",
    "quick_win": "가장 쉽게 자동화 가능한 작업"
  }},
  "feedback": {{
    "actionable": true/false,
    "message": "사용자에게 전달할 피드백 (한국어, 구체적으로)",
    "priority": "high|medium|low"
  }}
}}
```

핵심 규칙:
- 자동화 점수: 반복적 + 규칙 기반 = 높음, 창의적 + 판단 필요 = 낮음
- 피드백은 실행 가능한 것만 (actionable=true일 때만 message 작성)
- 작업명은 구체적으로 (❌ "문서 작업" → ✅ "월별 매출 보고서 작성")
"""


def summarize_events_for_prompt(events, max_tokens=3000):
    """이벤트 배치를 프롬프트용 요약으로 변환 (토큰 절약)"""
    lines = []
    char_budget = max_tokens * 3  # 대략적 토큰-문자 비율

    for e in events:
        etype = e.get('type', '')
        app = e.get('app', '')
        title = e.get('title', '')
        ts = e.get('timestamp', '')[:19]  # 초 단위까지

        if etype == 'keyboard.batch':
            for app_data in e.get('apps', []):
                text_preview = (app_data.get('text', '')[:200]
                                .replace('\n', ' ').replace('<BS>', ''))
                line = f"[{ts}] 키입력 | {app_data.get('app','')} | " \
                       f"{app_data.get('title','')[:50]} | " \
                       f"{app_data.get('char_count',0)}자 | \"{text_preview}\""
                lines.append(line)

        elif etype == 'app.switch':
            line = f"[{ts}] 앱전환 | {e.get('from_app','')} → {e.get('to_app','')} | " \
                   f"{e.get('to_title','')[:60]}"
            lines.append(line)

        elif etype == 'app.usage':
            line = f"[{ts}] 앱사용 | {app} ({e.get('category','')}) | " \
                   f"{e.get('duration_sec',0)}초 | {title[:60]}"
            lines.append(line)

        elif etype == 'clipboard.copy':
            preview = (e.get('preview', '')[:100]).replace('\n', ' ')
            line = f"[{ts}] 복사 | {app} | \"{preview}\""
            lines.append(line)

        elif etype == 'file.change':
            op = e.get('operation', '')
            fp = e.get('filename', '')
            diff = e.get('diff', {})
            diff_info = f"+{diff.get('lines_added',0)}/-{diff.get('lines_removed',0)}" if diff else ''
            line = f"[{ts}] 파일{op} | {fp} | {diff_info}"
            lines.append(line)

        elif etype == 'screen.capture':
            ocr = (e.get('ocr_text', '')[:200]).replace('\n', ' ')
            line = f"[{ts}] 화면 | {app} | OCR: \"{ocr}\""
            lines.append(line)

        # 토큰 예산 체크
        total = sum(len(l) for l in lines)
        if total > char_budget:
            lines.append(f"... (추가 {len(events) - len(lines)}개 이벤트 생략)")
            break

    return '\n'.join(lines)


async def _call_anthropic_direct(prompt, api_key, model):
    """공식 Anthropic API 직접 호출"""
    try:
        import anthropic
    except ImportError:
        logger.error("anthropic 패키지 필요: pip install anthropic")
        return None

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )
    text = response.content[0].text
    meta = {
        'input_tokens': response.usage.input_tokens,
        'output_tokens': response.usage.output_tokens,
    }
    return text, meta


async def _call_proxy(prompt, base_url, model):
    """CLIProxyAPI (OpenAI-compatible) 프록시 호출"""
    import urllib.request
    import urllib.error

    url = f"{base_url.rstrip('/')}/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2000,
        "temperature": 0.2,
    }).encode('utf-8')

    req = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer dummy',
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as e:
        logger.error(f"프록시 연결 실패 ({url}): {e}")
        logger.info("CLIProxyAPI가 실행 중인지 확인하세요 (기본: localhost:8080)")
        return None

    text = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    usage = data.get('usage', {})
    meta = {
        'input_tokens': usage.get('prompt_tokens', 0),
        'output_tokens': usage.get('completion_tokens', 0),
    }
    return text, meta


async def analyze_with_haiku(events, api_key=None):
    """Haiku로 이벤트 배치 분석

    api_key가 주어지면 기존 방식 (Anthropic 직접 호출).
    USE_MAX_PROXY=true이면 CLIProxyAPI 프록시 경유 (api_key 불필요).
    """
    from ..api_config import (
        USE_MAX_PROXY, API_BASE_URL, API_KEY, API_FORMAT,
        ANALYSIS_MODEL,
    )

    # 프록시 모드가 아닐 때만 API 키 필요
    if not USE_MAX_PROXY and not api_key:
        logger.warning("ANTHROPIC_API_KEY 미설정 — 분석 건너뜀")
        return None

    # 사전 필터
    filtered = pre_filter(events)
    if not filtered:
        return None

    # 프롬프트 생성
    summary = summarize_events_for_prompt(filtered)
    prompt = build_analysis_prompt(summary)

    try:
        if USE_MAX_PROXY:
            logger.debug(f"프록시 분석 호출: {API_BASE_URL} / {ANALYSIS_MODEL}")
            result_tuple = await _call_proxy(prompt, API_BASE_URL, ANALYSIS_MODEL)
        else:
            logger.debug(f"Anthropic 직접 호출: {ANALYSIS_MODEL}")
            result_tuple = await _call_anthropic_direct(
                prompt, api_key or API_KEY, ANALYSIS_MODEL
            )

        if not result_tuple:
            return None

        text, meta = result_tuple

        # JSON 추출
        json_start = text.find('{')
        json_end = text.rfind('}') + 1
        if json_start >= 0 and json_end > json_start:
            result = json.loads(text[json_start:json_end])
            result['_meta'] = {
                'analyzed_at': datetime.utcnow().isoformat() + 'Z',
                'events_count': len(filtered),
                'api_mode': 'proxy' if USE_MAX_PROXY else 'direct',
                **meta,
            }
            return result

    except json.JSONDecodeError:
        logger.warning("Haiku 응답 JSON 파싱 실패")
    except Exception as e:
        logger.error(f"Haiku 분석 실패: {e}")

    return None
