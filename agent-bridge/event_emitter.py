"""
event_emitter.py
─────────────────────────────────────────────────────────────────────────────
nenova_agent 파이프라인 이벤트 발행기

7단계 파이프라인의 각 단계에서 Orbit 이벤트 버스로 상태를 전송합니다.
기존 gsheet_sync.py와 병행 사용 (구글시트는 기존대로 유지).
─────────────────────────────────────────────────────────────────────────────
"""

from orbit_bridge import get_bridge

# 7단계 파이프라인 정의
PIPELINE_STAGES = {
    1: {"name": "수입/입고", "key": "import_incoming"},
    2: {"name": "검수/불량", "key": "inspection_defect"},
    3: {"name": "재고관리", "key": "inventory"},
    4: {"name": "발주/영업", "key": "order_sales"},
    5: {"name": "출고/분배", "key": "shipping_distribution"},
    6: {"name": "현장", "key": "field"},
    7: {"name": "시스템", "key": "system"},
}


def emit_pipeline_stage(stage_num, status="complete", details=None, correlation_id=None):
    """
    파이프라인 단계 이벤트 발행

    Args:
        stage_num: 1~7 단계 번호
        status: "start" | "complete" | "error"
        details: 추가 데이터 (dict)
        correlation_id: 관련 이벤트 연결용 ID
    """
    stage = PIPELINE_STAGES.get(stage_num)
    if not stage:
        raise ValueError(f"Invalid stage: {stage_num}. Must be 1-7")

    event_type = f"agent.pipeline.stage_{status}"
    data = {
        "stage": stage_num,
        "stage_name": stage["name"],
        "stage_key": stage["key"],
        "total_stages": 7,
        **(details or {}),
    }

    return get_bridge().publish(
        event_type, data, correlation_id=correlation_id
    )


def emit_kakao_message(room_name, message_text, sender=None, has_photo=False, correlation_id=None):
    """카카오톡 메시지 수신 이벤트"""
    return get_bridge().publish(
        "kakao.message.received",
        {
            "room": room_name,
            "text": message_text[:500],  # 최대 500자
            "sender": sender,
            "has_photo": has_photo,
        },
        correlation_id=correlation_id,
    )


def emit_kakao_mirror(room_name, mirror_room, success=True, correlation_id=None):
    """카카오워크 미러 전송 이벤트"""
    return get_bridge().publish(
        "kakao.message.forwarded",
        {
            "source_room": room_name,
            "mirror_room": mirror_room,
            "success": success,
        },
        correlation_id=correlation_id,
    )


def emit_order_detected(room_name, customer, products, raw_text=None, correlation_id=None):
    """주문 패턴 감지 이벤트"""
    return get_bridge().publish(
        "kakao.order.detected",
        {
            "room": room_name,
            "customer": customer,
            "products": products,  # [{"name": ..., "qty": ..., "unit": ...}]
            "raw_text": (raw_text or "")[:300],
        },
        correlation_id=correlation_id,
    )


def emit_sheets_updated(layer, tab_name, row_count=0, correlation_id=None):
    """구글시트 업데이트 이벤트"""
    return get_bridge().publish(
        "agent.sheets.updated",
        {
            "layer": layer,  # "L1" | "L2" | "L3"
            "tab": tab_name,
            "rows_written": row_count,
        },
        correlation_id=correlation_id,
    )


def emit_anomaly(stage_num, anomaly_type, description, severity="medium", correlation_id=None):
    """파이프라인 이상 감지 이벤트"""
    stage = PIPELINE_STAGES.get(stage_num, {})
    return get_bridge().publish(
        "agent.pipeline.anomaly",
        {
            "stage": stage_num,
            "stage_name": stage.get("name", "unknown"),
            "anomaly_type": anomaly_type,
            "description": description[:500],
            "severity": severity,  # "low" | "medium" | "high" | "critical"
        },
        correlation_id=correlation_id,
    )


# ─── 사용 예시 ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)

    # 파이프라인 단계 테스트
    print("=== 파이프라인 이벤트 발행 테스트 ===")
    for stage in range(1, 8):
        result = emit_pipeline_stage(stage, "complete", {"test": True})
        print(f"Stage {stage}: {'OK' if result else 'queued'}")
