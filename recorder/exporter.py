"""세션 데이터를 JSON 자동화 스크립트로 내보내기"""
import json
from . import db_schema as db


def export_session(session_id, output_path=None, filter_types=None):
    """
    세션 → JSON 자동화 포맷 변환
    filter_types: None=전체, ["keyboard"], ["mouse"], ["keyboard","mouse"] 등
    """
    session = db.get_session(session_id)
    if not session:
        raise ValueError(f"세션을 찾을 수 없음: {session_id}")

    events = db.get_events(session_id)

    # 필터링
    type_map = {
        "keyboard": ["keydown", "keyup"],
        "mouse": ["mouse_click", "mouse_move", "mouse_scroll"],
        "screenshot": ["screenshot"],
    }

    if filter_types:
        allowed = set()
        for ft in filter_types:
            allowed.update(type_map.get(ft, [ft]))
        events = [e for e in events if e["event_type"] in allowed]

    # JSON 파싱
    for e in events:
        if isinstance(e.get("data_json"), str):
            try:
                e["data"] = json.loads(e["data_json"])
            except (json.JSONDecodeError, TypeError):
                e["data"] = {}
            del e["data_json"]

    # mouse_move 압축 → mouse_path
    actions = _compress_events(events)

    result = {
        "version": "1.0",
        "session": {
            "id": session["id"],
            "name": session["name"],
            "started_at": session["started_at"],
            "ended_at": session.get("ended_at"),
            "total_events": len(events),
            "total_actions": len(actions),
        },
        "actions": actions,
    }

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[exporter] 내보내기 완료: {output_path} ({len(actions)}개 액션)")

    return result


def _compress_events(events):
    """연속 mouse_move → mouse_path 압축, 나머지는 그대로"""
    actions = []
    move_buffer = []

    def flush_moves():
        if not move_buffer:
            return
        if len(move_buffer) == 1:
            actions.append(move_buffer[0])
        else:
            # 연속 이동 → 경로로 압축
            points = []
            for m in move_buffer:
                d = m.get("data", {})
                points.append({
                    "x": d.get("x", 0),
                    "y": d.get("y", 0),
                    "t": m.get("timestamp_ms", 0),
                })
            actions.append({
                "type": "mouse_path",
                "timestamp_ms": move_buffer[0].get("timestamp_ms", 0),
                "duration_ms": move_buffer[-1].get("timestamp_ms", 0) - move_buffer[0].get("timestamp_ms", 0),
                "points": points,
            })

    for event in events:
        etype = event.get("event_type", "")
        if etype == "mouse_move":
            move_buffer.append(event)
        else:
            flush_moves()
            move_buffer = []
            actions.append({
                "type": etype,
                "timestamp_ms": event.get("timestamp_ms", 0),
                "data": event.get("data", {}),
            })

    flush_moves()
    return actions
