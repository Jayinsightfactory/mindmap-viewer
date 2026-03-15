"""
storage/server_sync.py
Orbit AI 서버로 분석 결과 동기화

전송 데이터 (원본이 아닌 분석 결과만):
  - 작업 그래프 (어떤 작업을 어떤 순서로 하는지)
  - 분석 요약 (업무 패턴, 병목, 자동화 가능 영역)
  - 피드백 (actionable한 것만)
"""
import json
import logging

import requests

from . import local_db

logger = logging.getLogger('orbit.sync')


def sync_to_server(server_url, api_token, user_id):
    """미전송 데이터를 서버로 전송"""
    if not server_url or not api_token:
        logger.debug("서버 URL 또는 토큰 미설정")
        return 0

    pending = local_db.get_pending_syncs(limit=20)
    if not pending:
        return 0

    success = 0
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_token}',
    }

    for item in pending:
        try:
            payload = json.loads(item['payload_json'])
            payload['user_id'] = user_id

            resp = requests.post(
                f"{server_url.rstrip('/')}/api/agent-data",
                json=payload,
                headers=headers,
                timeout=30,
            )

            if resp.status_code in (200, 201):
                local_db.mark_synced(item['id'])
                success += 1
            else:
                logger.warning(f"서버 응답 {resp.status_code}: {resp.text[:200]}")
                local_db.mark_sync_failed(item['id'])

        except requests.RequestException as e:
            logger.warning(f"서버 전송 실패: {e}")
            local_db.mark_sync_failed(item['id'])

    if success:
        logger.info(f"서버 동기화 완료: {success}/{len(pending)}")
    return success


def enqueue_analysis_result(result):
    """분석 결과를 동기화 대기열에 추가"""
    if not result:
        return

    payload = {
        'type': 'agent.analysis',
        'timestamp': result.get('_meta', {}).get('analyzed_at', ''),
        'data': {
            'tasks': result.get('tasks', []),
            'work_pattern': result.get('work_pattern', {}),
            'feedback': result.get('feedback', {}),
        }
    }
    local_db.enqueue_sync(payload)


def enqueue_task_graph(task):
    """작업 그래프를 동기화 대기열에 추가"""
    payload = {
        'type': 'agent.task_graph',
        'timestamp': task.get('last_seen', ''),
        'data': task,
    }
    local_db.enqueue_sync(payload)
