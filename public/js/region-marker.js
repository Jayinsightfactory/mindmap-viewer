/**
 * region-marker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 영역 드래그 → "이 부분 수정 요청" 시각적 마킹 위젯 (드롭인)
 *
 * 사용: <script src="/js/region-marker.js" defer></script> 한 줄 삽입.
 *
 * 동작:
 *  - 우하단 토글 버튼(✏️ 수정요청)으로 마킹 모드 ON/OFF
 *  - 모드 ON 상태에서 페이지를 드래그하면 사각형 영역이 그려짐
 *  - 영역마다 번호 뱃지 + 메모 입력칸 → "무엇을 어떻게 고칠지" 작성
 *  - 영역은 localStorage에 페이지별로 저장 (새로고침해도 유지)
 *  - "내보내기"로 전체 마킹(영역 좌표 + 위치 요소 + 메모)을 클립보드에 복사
 *    → 그대로 붙여넣어 수정 요청으로 전달 가능
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';
  if (window.__regionMarkerLoaded) return;
  window.__regionMarkerLoaded = true;

  var STORAGE_KEY = 'regionMarks:' + location.pathname;
  var MIN_SIZE = 12; // 이보다 작은 드래그는 무시(클릭으로 간주)

  var state = {
    active: false,
    marks: [],     // {id,x,y,w,h,note,selector}
    seq: 1,
  };

  // ── 저장/복원 ───────────────────────────────────────────────────────────────
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.marks)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state.marks = JSON.parse(raw) || [];
        state.marks.forEach(function (m) { if (m.id >= state.seq) state.seq = m.id + 1; });
      }
    } catch (e) { state.marks = []; }
  }

  // ── 드래그 지점의 요소 식별 (수정 대상 특정용) ──────────────────────────────
  function describeElementAt(pageX, pageY) {
    var prev = layer.style.display;
    layer.style.display = 'none';
    var el = document.elementFromPoint(pageX - window.scrollX, pageY - window.scrollY);
    layer.style.display = prev;
    if (!el) return '(unknown)';
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      var seg = node.tagName.toLowerCase();
      if (node.id) { seg += '#' + node.id; parts.unshift(seg); break; }
      if (node.className && typeof node.className === 'string') {
        var cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) seg += '.' + cls;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    var txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return parts.join(' > ') + (txt ? '  「' + txt + '」' : '');
  }

  // ── 스타일 주입 ─────────────────────────────────────────────────────────────
  var css = ''
    + '#rm-toggle{position:fixed;right:18px;bottom:18px;z-index:2147483600;'
    + 'background:#5b8cff;color:#fff;border:none;border-radius:24px;padding:11px 16px;'
    + 'font:600 13px/1 Inter,-apple-system,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);'
    + 'display:flex;align-items:center;gap:7px;transition:background .15s,transform .1s}'
    + '#rm-toggle:hover{transform:translateY(-2px)}'
    + '#rm-toggle.on{background:#e8554e}'
    + '#rm-bar{position:fixed;right:18px;bottom:64px;z-index:2147483600;display:none;'
    + 'flex-direction:column;gap:6px;align-items:flex-end}'
    + '#rm-bar.show{display:flex}'
    + '.rm-act{background:#18223d;color:#e6ecff;border:1px solid #2f3c5e;border-radius:8px;'
    + 'padding:7px 12px;font:600 12px Inter,sans-serif;cursor:pointer;white-space:nowrap}'
    + '.rm-act:hover{background:#24304f}'
    + '#rm-layer{position:fixed;inset:0;z-index:2147483500;cursor:crosshair;display:none;'
    + 'background:rgba(2,6,23,.04)}'
    + '#rm-layer.on{display:block}'
    + '#rm-rubber{position:fixed;border:2px dashed #e8554e;background:rgba(232,85,78,.12);'
    + 'pointer-events:none;display:none;z-index:2147483520}'
    + '.rm-mark{position:absolute;z-index:2147483400;border:2px solid #e8554e;'
    + 'background:rgba(232,85,78,.10);border-radius:4px;box-sizing:border-box}'
    + '.rm-mark .rm-badge{position:absolute;top:-12px;left:-12px;width:24px;height:24px;'
    + 'background:#e8554e;color:#fff;border-radius:50%;display:flex;align-items:center;'
    + 'justify-content:center;font:700 12px Inter,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.4)}'
    + '.rm-mark .rm-note{position:absolute;left:0;top:100%;margin-top:4px;width:max(180px,100%);'
    + 'background:#0f1830;color:#e6ecff;border:1px solid #2f3c5e;border-radius:6px;padding:6px 8px;'
    + 'font:400 12px Inter,sans-serif;resize:vertical;min-height:34px;display:none}'
    + '.rm-mark.sel .rm-note{display:block}'
    + '.rm-mark .rm-del{position:absolute;top:-12px;right:-12px;width:22px;height:22px;'
    + 'background:#0f1830;color:#fff;border:1px solid #2f3c5e;border-radius:50%;cursor:pointer;'
    + 'font:700 12px/1 Inter,sans-serif;display:flex;align-items:center;justify-content:center}'
    + '#rm-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483600;'
    + 'background:#3fd68b;color:#04210f;padding:9px 16px;border-radius:8px;font:600 13px Inter,sans-serif;'
    + 'display:none}';
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── DOM 구성 ────────────────────────────────────────────────────────────────
  var toggle = el('button', { id: 'rm-toggle' });
  toggle.innerHTML = '<span>✏️</span><span>수정요청</span>';

  var bar = el('div', { id: 'rm-bar' });
  var btnExport = el('button', { class: 'rm-act' }); btnExport.textContent = '📋 내보내기';
  var btnClear = el('button', { class: 'rm-act' }); btnClear.textContent = '🗑 전체 지우기';
  bar.appendChild(btnExport); bar.appendChild(btnClear);

  var layer = el('div', { id: 'rm-layer' });
  var rubber = el('div', { id: 'rm-rubber' });
  var toast = el('div', { id: 'rm-toast' });

  document.body.appendChild(toggle);
  document.body.appendChild(bar);
  document.body.appendChild(layer);
  document.body.appendChild(rubber);
  document.body.appendChild(toast);

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.style.display = 'none'; }, 2200);
  }

  // ── 마킹 모드 토글 ──────────────────────────────────────────────────────────
  function setActive(on) {
    state.active = on;
    toggle.classList.toggle('on', on);
    bar.classList.toggle('show', on);
    layer.classList.toggle('on', on);
    toggle.querySelector('span:last-child').textContent = on ? '완료' : '수정요청';
  }
  toggle.addEventListener('click', function () { setActive(!state.active); });

  // ── 드래그로 영역 그리기 ────────────────────────────────────────────────────
  var drag = null;
  layer.addEventListener('mousedown', function (e) {
    drag = { sx: e.clientX, sy: e.clientY };
    rubber.style.display = 'block';
    updateRubber(e.clientX, e.clientY);
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (drag) updateRubber(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', function (e) {
    if (!drag) return;
    var r = rectOf(drag.sx, drag.sy, e.clientX, e.clientY);
    rubber.style.display = 'none';
    var d = drag; drag = null;
    if (r.w < MIN_SIZE || r.h < MIN_SIZE) return;
    createMark({
      id: state.seq++,
      x: r.x + window.scrollX,
      y: r.y + window.scrollY,
      w: r.w, h: r.h,
      note: '',
      selector: describeElementAt(r.x + r.w / 2 + window.scrollX, r.y + r.h / 2 + window.scrollY),
    }, true);
    save();
  });
  function rectOf(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  function updateRubber(cx, cy) {
    var r = rectOf(drag.sx, drag.sy, cx, cy);
    rubber.style.left = r.x + 'px';
    rubber.style.top = r.y + 'px';
    rubber.style.width = r.w + 'px';
    rubber.style.height = r.h + 'px';
  }

  // ── 마킹 DOM 렌더 ───────────────────────────────────────────────────────────
  function createMark(m, isNew) {
    if (isNew) state.marks.push(m);
    var box = el('div', { class: 'rm-mark' });
    box.dataset.id = m.id;
    box.style.left = m.x + 'px';
    box.style.top = m.y + 'px';
    box.style.width = m.w + 'px';
    box.style.height = m.h + 'px';

    var badge = el('div', { class: 'rm-badge' }); badge.textContent = m.id;
    var del = el('div', { class: 'rm-del' }); del.textContent = '×';
    var note = el('textarea', { class: 'rm-note', placeholder: '이 영역을 어떻게 수정할지 적으세요...' });
    note.value = m.note || '';

    box.appendChild(badge);
    box.appendChild(del);
    box.appendChild(note);
    document.body.appendChild(box);

    badge.addEventListener('click', function (ev) {
      ev.stopPropagation();
      box.classList.toggle('sel');
      if (box.classList.contains('sel')) note.focus();
    });
    note.addEventListener('click', function (ev) { ev.stopPropagation(); });
    note.addEventListener('input', function () {
      m.note = note.value; save();
    });
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      state.marks = state.marks.filter(function (x) { return x.id !== m.id; });
      box.remove();
      save();
    });
    if (isNew) { box.classList.add('sel'); note.focus(); }
  }

  // ── 내보내기 / 전체 삭제 ────────────────────────────────────────────────────
  btnExport.addEventListener('click', function () {
    if (!state.marks.length) { showToast('마킹된 영역이 없습니다'); return; }
    var lines = ['# 수정 요청 영역 — ' + location.href, ''];
    state.marks.forEach(function (m) {
      lines.push('[' + m.id + '] 위치: ' + m.selector);
      lines.push('    좌표: x=' + Math.round(m.x) + ' y=' + Math.round(m.y)
        + ' w=' + Math.round(m.w) + ' h=' + Math.round(m.h));
      lines.push('    요청: ' + (m.note ? m.note : '(메모 없음)'));
      lines.push('');
    });
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showToast('클립보드에 복사됨 (' + state.marks.length + '개)'); },
        function () { fallbackCopy(text); }
      );
    } else { fallbackCopy(text); }
    console.log('[region-marker] export:\n' + text);
  });
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('클립보드에 복사됨'); }
    catch (e) { showToast('복사 실패 — 콘솔 참고'); }
    ta.remove();
  }
  btnClear.addEventListener('click', function () {
    if (!state.marks.length) return;
    if (!confirm('이 페이지의 마킹을 모두 지우시겠습니까?')) return;
    state.marks = [];
    save();
    Array.prototype.slice.call(document.querySelectorAll('.rm-mark')).forEach(function (n) { n.remove(); });
    showToast('모두 지워짐');
  });

  // ── 초기화 ──────────────────────────────────────────────────────────────────
  load();
  state.marks.forEach(function (m) { createMark(m, false); });
})();
