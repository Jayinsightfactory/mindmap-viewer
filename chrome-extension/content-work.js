/**
 * content-work.js — 업무 웹앱(ECOUNT 등) work-step 캡처 (골모드 의미기반 수집)
 *
 * 목적: 데스크톱 UIA와 동일한 work-step 스키마를 웹에서 생성.
 *   { action: click|input|navigate|read_table, target:{selector,label,text},
 *     value, context:{url,menu,page}, t }
 * 전송: chrome.runtime.sendMessage → background.js → 서버 /api/hook (type='work.step')
 *
 * 범위: manifest의 work-domain 매칭에서만 실행(개인 브라우징 제외).
 * Chrome/Edge 공통 (Chromium MV3).
 */
(function () {
  'use strict';
  if (window.__orbitWorkInjected) return;
  window.__orbitWorkInjected = true;

  // ── 민감 페이지/자격증명 차단 (로그인 ID/회사코드/비밀번호 등 절대 미수집) ──
  function isSensitivePage() {
    const u = location.href.toLowerCase();
    if (/login|signin|sign-in|auth|logon|password|계정/.test(u)) return true;
    // 비밀번호 입력이 있는 페이지(=로그인/인증 폼)는 통째로 캡처 제외
    if (document.querySelector('input[type="password"]')) return true;
    return false;
  }
  // 자격증명 계열 필드(회사코드/아이디/비밀번호 등) 판별
  function isCredentialField(el) {
    if (!el) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'email') return true;
    const ac = (el.getAttribute && (el.getAttribute('autocomplete') || '')).toLowerCase();
    if (/username|password|one-time|current-password|new-password/.test(ac)) return true;
    const hint = ((el.id || '') + '|' + (el.name || '')).toLowerCase();
    if (/(^|_)(id|com_code|comcode|userid|user_id|login|pass|pw|pwd|otp)($|_)/.test(hint)) return true;
    // 비밀번호 필드를 포함한 폼(로그인 폼) 안의 입력은 전부 제외
    const form = el.closest && el.closest('form');
    if (form && form.querySelector('input[type="password"]')) return true;
    return false;
  }

  const SEND = (step) => {
    try {
      if (isSensitivePage()) return; // 로그인/인증 페이지는 캡처 안 함
      chrome.runtime.sendMessage({ type: 'orbit-work-step', step: {
        ...step, url: location.href, title: document.title, t: new Date().toISOString(),
      } }).catch(() => {});
    } catch (_) {}
  };

  // ── 안정 셀렉터 생성 (id > name > data-* > 텍스트+태그 경로) ──────────────
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${el.id}`;
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    // data-* 안정 속성
    for (const a of ['data-testid', 'data-id', 'data-col', 'data-field', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) return `${el.tagName.toLowerCase()}[${a}="${v}"]`;
    }
    // 짧은 조상 경로 (nth-of-type 3단계)
    const parts = [];
    let cur = el;
    for (let i = 0; i < 3 && cur && cur.nodeType === 1 && cur.tagName !== 'BODY'; i++) {
      let seg = cur.tagName.toLowerCase();
      const cls = (cur.className && typeof cur.className === 'string')
        ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      parts.unshift(seg + cls);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ── 입력요소의 라벨 찾기 ────────────────────────────────────────────────
  function labelFor(el) {
    if (!el) return '';
    if (el.id) {
      const lab = document.querySelector(`label[for="${el.id}"]`);
      if (lab) return lab.innerText.trim().slice(0, 40);
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) return wrap.innerText.trim().slice(0, 40);
    const ph = el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title'));
    if (ph) return ph.trim().slice(0, 40);
    // 앞선 형제/셀 헤더 추정
    const prev = el.previousElementSibling;
    if (prev && prev.innerText) return prev.innerText.trim().slice(0, 40);
    return '';
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  // ── 클릭: 버튼/링크/메뉴/셀 ─────────────────────────────────────────────
  let _lastClickKey = '', _lastClickAt = 0;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"], td, th, .btn, [onclick]') || e.target;
    if (!el) return;
    const text = clean(el.innerText || el.value || el.getAttribute('aria-label') || '');
    if (!text && el.tagName === 'TD') return; // 빈 셀 무시
    const key = selectorFor(el) + '|' + text;
    const now = Date.now();
    if (key === _lastClickKey && now - _lastClickAt < 400) return; // 더블클릭 중복 방지
    _lastClickKey = key; _lastClickAt = now;
    SEND({ action: 'click', target: { selector: selectorFor(el), text, tag: el.tagName.toLowerCase() } });
  }, true);

  // ── 입력 확정: change(blur시 발생) — 어느 필드에 무슨 값 ──────────────────
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    if (isCredentialField(el)) return; // 비밀번호/아이디/회사코드 등 자격증명 미수집
    let value = el.value;
    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) value = el.selectedOptions[0].text;
    SEND({ action: 'input', target: { selector: selectorFor(el), label: labelFor(el) }, value: clean(String(value)) });
  }, true);

  // ── 네비게이션(SPA 포함): URL 변화 감지 → 메뉴 컨텍스트 ──────────────────
  let _lastUrl = location.href;
  function onNav() {
    if (location.href === _lastUrl) return;
    _lastUrl = location.href;
    // ECOUNT 등: 메뉴명 추정(활성 탭/브레드크럼)
    const menu = clean(
      (document.querySelector('.tab.active, .menu.active, [aria-selected="true"]') || {}).innerText ||
      (document.querySelector('h1, .page-title, .title') || {}).innerText || '');
    SEND({ action: 'navigate', context: { menu } });
    setTimeout(scanTable, 1200); // 페이지 로드 후 테이블 스캔
  }
  setInterval(onNav, 800);
  window.addEventListener('popstate', onNav);

  // ── 테이블 읽기(리스트 화면): 헤더 + 행수 + 샘플 (경량) ───────────────────
  let _lastTableSig = '';
  function scanTable() {
    try {
      const tables = document.querySelectorAll('table');
      let best = null, bestRows = 0;
      tables.forEach((t) => {
        const rows = t.querySelectorAll('tr').length;
        if (rows > bestRows) { bestRows = rows; best = t; }
      });
      if (!best || bestRows < 3) return;
      // 헤더: thead th 우선, 없으면 첫 행 셀을 헤더로 (중복 방지)
      let headerCells = Array.from(best.querySelectorAll('thead th'));
      if (!headerCells.length) headerCells = Array.from(best.querySelectorAll('tr:first-child th, tr:first-child td'));
      const headers = headerCells.map((h) => clean(h.innerText)).filter(Boolean).slice(0, 20);
      const allRows = Array.from(best.querySelectorAll('tbody tr, tr'));
      // 헤더가 thead에서 왔으면 tbody 전체, 첫행에서 왔으면 첫행 제외
      const bodyRows = best.querySelector('thead th') ? Array.from(best.querySelectorAll('tbody tr')) : allRows.slice(1);
      const sample = bodyRows.slice(0, 3).map((r) =>
        Array.from(r.querySelectorAll('td')).map((c) => clean(c.innerText)).slice(0, 20));
      const sig = headers.join('|') + '#' + bodyRows.length;
      if (sig === _lastTableSig) return; // 동일 테이블 재전송 방지
      _lastTableSig = sig;
      SEND({ action: 'read_table', context: { headers, rowCount: bodyRows.length }, sample });
    } catch (_) {}
  }
  // 최초 로드 시 1회
  setTimeout(scanTable, 1500);
})();
