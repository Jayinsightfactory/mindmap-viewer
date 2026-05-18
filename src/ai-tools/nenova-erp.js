'use strict';

/**
 * src/ai-tools/nenova-erp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * nenova ERP Tool Use 정의 + 디스패처
 *
 * Anthropic Tool Use 스키마 형식:
 *   { name, description, input_schema: { type, properties, required } }
 *
 * 디스패처:
 *   dispatch(toolName, toolInput, bearerToken) → Promise<object>
 *   내부적으로 http://localhost:PORT/api/nenova/... 호출 (외부 의존성 없음)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const http  = require('http');

// ── 포트 결정 ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4747;

// ── 내부 HTTP GET 헬퍼 ────────────────────────────────────────────────────────
function internalGet(path, bearerToken) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port:     PORT,
      path,
      method:   'GET',
      headers:  {
        'Authorization': `Bearer ${bearerToken}`,
        'Accept':        'application/json',
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error('internal request timeout')); });
    req.end();
  });
}

// ── 결과 크기 제한 (>50 KB 이면 상위 N개로 잘라냄) ───────────────────────────
function truncateResult(obj, label) {
  const str = JSON.stringify(obj);
  if (str.length <= 51200) return obj;

  // 배열이면 상위 30개
  if (Array.isArray(obj)) {
    return {
      _truncated: true,
      _total:     obj.length,
      _note:      `${label}: 결과가 크므로 상위 30개만 반환합니다.`,
      items:      obj.slice(0, 30),
    };
  }
  // 객체 내부 배열 찾기
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 30) {
      return {
        ...obj,
        [k]:      v.slice(0, 30),
        _truncated: true,
        _note:    `${label}.${k}: 상위 30개만 반환합니다.`,
      };
    }
  }
  return obj;
}

// ── 차수 파싱 유틸 ────────────────────────────────────────────────────────────
// "20"   → ["20-01", "20-02"]  (합산 대상 2개)
// "20-01" → ["20-01"]
// "20-1"  → ["20-01"] (정규화)
function parseRound(round) {
  if (!round) return [];
  const s = String(round).trim();
  // 정확히 숫자만 (예: "20")
  if (/^\d+$/.test(s)) {
    const w = s.padStart(2, '0');
    return [`${w}-01`, `${w}-02`];
  }
  // "20-1" → "20-01"
  const m = s.match(/^(\d+)-(\d+)$/);
  if (m) {
    const w = m[1].padStart(2, '0');
    const d = m[2].padStart(2, '0');
    return [`${w}-${d}`];
  }
  return [s];
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Tool Use 스키마 정의
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name:        'get_distribution_by_round',
    description: '특정 차수의 분배(=출고) 현황을 조회합니다. round에 "20" 입력 시 20-01과 20-02를 자동 합산합니다. "20-01"처럼 세부 차수를 입력하면 단일 조회합니다. manager(담당자 이름) 또는 country(원산지) 로 추가 필터링 가능.',
    input_schema: {
      type:       'object',
      properties: {
        round:   { type: 'string', description: '차수 예: "20" (합산), "20-01" (단일)' },
        manager: { type: 'string', description: '담당자 이름 (옵션)' },
        country: { type: 'string', description: '원산지/국가 (옵션)' },
      },
      required: ['round'],
    },
  },
  {
    name:        'get_distribution_by_vendor_round',
    description: '특정 거래처(업체)의 차수별 분배(출고) 현황을 조회합니다. 어느 업체가 몇 박스 받았는지 확인할 때 사용합니다.',
    input_schema: {
      type:       'object',
      properties: {
        vendor_key: { type: 'number', description: '거래처 키(숫자 ID)' },
        round:      { type: 'string', description: '차수 예: "20" (합산), "20-01" (단일)' },
      },
      required: ['vendor_key', 'round'],
    },
  },
  {
    name:        'get_vendor_top_products',
    description: '특정 거래처가 주로 구매하는 상위 품목과 단가를 조회합니다. 거래처별 선호 품목 파악에 사용합니다.',
    input_schema: {
      type:       'object',
      properties: {
        vendor_key: { type: 'number', description: '거래처 키(숫자 ID)' },
        limit:      { type: 'number', description: '반환 개수 (기본 10)' },
      },
      required: ['vendor_key'],
    },
  },
  {
    name:        'compare_year_vendor',
    description: '특정 거래처의 금년과 작년 같은 차수를 비교합니다. "올해 20차 vs 작년 20차" 비교 요청 시 사용합니다.',
    input_schema: {
      type:       'object',
      properties: {
        vendor_key:    { type: 'number', description: '거래처 키(숫자 ID)' },
        current_round: { type: 'string', description: '현재 차수 예: "20-01"' },
      },
      required: ['vendor_key', 'current_round'],
    },
  },
  {
    name:        'list_my_vendors',
    description: '담당자가 관리하는 거래처 목록을 조회합니다. "내 업체 목록", "내 거래처" 질문 시 사용합니다. manager 인자 없으면 전체 거래처를 반환합니다.',
    input_schema: {
      type:       'object',
      properties: {
        manager: { type: 'string', description: '담당자 이름 (옵션; 없으면 전체)' },
      },
      required: [],
    },
  },
  {
    name:        'get_orders_by_round',
    description: '특정 차수의 수입 주문 목록을 조회합니다. 수입부 담당자가 어느 차수에 어떤 품목을 얼마나 주문했는지 확인할 때 사용합니다.',
    input_schema: {
      type:       'object',
      properties: {
        round:   { type: 'string', description: '차수 예: "20" (합산), "20-01" (단일)' },
        country: { type: 'string', description: '원산지/국가 필터 (옵션)' },
      },
      required: ['round'],
    },
  },
  {
    name:        'get_inventory',
    description: '현재 재고 현황(ProductStock)을 조회합니다. 입고·분배가 이미 반영된 스냅샷 값입니다. 품목키, 꽃 이름, 국가로 필터링 가능.',
    input_schema: {
      type:       'object',
      properties: {
        product_key: { type: 'number', description: '상품 키(숫자 ID) (옵션)' },
        flower:      { type: 'string', description: '꽃 이름 (옵션)' },
        country:     { type: 'string', description: '원산지/국가 (옵션)' },
      },
      required: [],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 도구 디스패처
// ─────────────────────────────────────────────────────────────────────────────
async function dispatch(toolName, toolInput, bearerToken) {
  switch (toolName) {

    case 'get_distribution_by_round': {
      const { round, manager, country } = toolInput;
      const weeks = parseRound(round);
      if (weeks.length === 0) throw new Error(`차수 파싱 실패: ${round}`);

      const results = await Promise.all(weeks.map(w => {
        const params = new URLSearchParams({ week: w });
        if (manager) params.set('manager', manager);
        if (country) params.set('country', country);
        return internalGet(`/api/nenova/shipments?${params}`, bearerToken);
      }));

      if (weeks.length === 1) {
        return truncateResult(results[0], 'shipments');
      }
      // 합산
      const merged = { rounds: weeks, _merged: true };
      let totalBoxes = 0, items = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const list = Array.isArray(r) ? r : (r.items || r.data || []);
        list.forEach(row => {
          totalBoxes += (row.boxes || row.qty || row.quantity || 0);
        });
        items = items.concat(list.map(row => ({ ...row, _round: weeks[i] })));
      }
      merged.totalBoxes = totalBoxes;
      merged.itemCount  = items.length;
      merged.items      = items;
      return truncateResult(merged, 'shipments_merged');
    }

    case 'get_distribution_by_vendor_round': {
      const { vendor_key, round } = toolInput;
      const weeks = parseRound(round);
      if (weeks.length === 0) throw new Error(`차수 파싱 실패: ${round}`);

      const results = await Promise.all(weeks.map(w => {
        const params = new URLSearchParams({ week: w, custKey: vendor_key });
        return internalGet(`/api/nenova/shipments?${params}`, bearerToken);
      }));

      if (weeks.length === 1) return truncateResult(results[0], 'shipments_vendor');
      const items = results.flatMap((r, i) => {
        const list = Array.isArray(r) ? r : (r.items || r.data || []);
        return list.map(row => ({ ...row, _round: weeks[i] }));
      });
      return truncateResult({ rounds: weeks, _merged: true, vendor_key, items }, 'shipments_vendor_merged');
    }

    case 'get_vendor_top_products': {
      const { vendor_key, limit = 10 } = toolInput;
      const result = await internalGet(`/api/nenova/customers/${vendor_key}/products`, bearerToken);
      const list = Array.isArray(result) ? result : (result.items || result.data || []);
      return { vendor_key, items: list.slice(0, limit) };
    }

    case 'compare_year_vendor': {
      const { vendor_key, current_round } = toolInput;
      const weeks = parseRound(current_round);
      const week  = weeks[0] || current_round;

      // 올해 / 작년 두 번 조회 (year 파라미터 지원 여부 불확실 → 조회 후 필터는 LLM이)
      const [thisYear, lastYear] = await Promise.all([
        internalGet(`/api/nenova/shipments?week=${week}&custKey=${vendor_key}&year=current`, bearerToken)
          .catch(() => internalGet(`/api/nenova/shipments?week=${week}&custKey=${vendor_key}`, bearerToken)),
        internalGet(`/api/nenova/shipments?week=${week}&custKey=${vendor_key}&year=last`, bearerToken)
          .catch(() => ({ _note: '작년 데이터 없음' })),
      ]);
      return {
        vendor_key,
        round:    week,
        thisYear: truncateResult(thisYear, 'thisYear'),
        lastYear: truncateResult(lastYear, 'lastYear'),
      };
    }

    case 'list_my_vendors': {
      const { manager } = toolInput;
      const params = new URLSearchParams();
      if (manager) params.set('manager', manager);
      const qs = params.toString();
      const result = await internalGet(`/api/nenova/customers${qs ? '?' + qs : ''}`, bearerToken);
      return truncateResult(result, 'customers');
    }

    case 'get_orders_by_round': {
      const { round, country } = toolInput;
      const weeks = parseRound(round);
      if (weeks.length === 0) throw new Error(`차수 파싱 실패: ${round}`);

      const results = await Promise.all(weeks.map(w => {
        const params = new URLSearchParams({ week: w });
        if (country) params.set('country', country);
        return internalGet(`/api/nenova/orders?${params}`, bearerToken);
      }));

      if (weeks.length === 1) return truncateResult(results[0], 'orders');
      const items = results.flatMap((r, i) => {
        const list = Array.isArray(r) ? r : (r.items || r.data || []);
        return list.map(row => ({ ...row, _round: weeks[i] }));
      });
      return truncateResult({ rounds: weeks, _merged: true, items }, 'orders_merged');
    }

    case 'get_inventory': {
      const { product_key, flower, country } = toolInput;
      const params = new URLSearchParams();
      if (product_key) params.set('key',     product_key);
      if (flower)      params.set('flower',  flower);
      if (country)     params.set('country', country);
      const qs = params.toString();
      const result = await internalGet(`/api/nenova/products/stock${qs ? '?' + qs : ''}`, bearerToken);
      return truncateResult(result, 'stock');
    }

    default:
      throw new Error(`알 수 없는 도구: ${toolName}`);
  }
}

module.exports = { TOOLS, dispatch };
