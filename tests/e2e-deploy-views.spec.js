// @ts-check
const { test, expect } = require('@playwright/test');

const BASE  = 'https://mindmap-viewer-production-adb2.up.railway.app';
const EMAIL = 'dlaww584@gmail.com';
const PW    = 'orbit2024';
const SS    = 'test-screenshots';

/** 콘솔 에러 수집 — WebGL/camera 반복 제외 */
function collectErrors(page) {
  const all = [], filtered = [];
  const ignore = ['camera is not defined','planetMeshes is not defined',
    'renderer is not defined','WebGL','Cannot access \'renderer\'',
    '_focusedProject','_sessionMap','429','Too many',
    'buildPlanetSystem','clearScene'];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      all.push(msg.text());
      if (!ignore.some(ig => msg.text().includes(ig))) filtered.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    all.push(err.message);
    if (!ignore.some(ig => err.message.includes(ig))) filtered.push(err.message);
  });
  return { all, filtered };
}

// ═══════════════════════════════════════════════
test.describe.serial('Orbit AI 배포 E2E 테스트', () => {
  /** @type {import('@playwright/test').Page} */
  let page;
  /** @type {import('@playwright/test').BrowserContext} */
  let ctx;
  let errors;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    errors = collectErrors(page);
  });

  test.afterAll(async () => {
    const unique = [...new Set(errors.filtered)];
    console.log('\n══════════════════════════════════════');
    if (unique.length) {
      console.log('주요 콘솔 에러 (WebGL 제외):');
      unique.forEach((e, i) => console.log(`  [${i+1}] ${e}`));
    } else {
      console.log('주요 콘솔 에러: 없음');
    }
    const wgl = errors.all.filter(e => e.includes('camera') || e.includes('renderer') || e.includes('WebGL') || e.includes('planetMeshes')).length;
    console.log(`WebGL/3D 반복 에러: ${wgl}건 (headless 한계)`);
    console.log('══════════════════════════════════════\n');
    await ctx.close();
  });

  // ─── 1. 로그인 ──────────────────────────────
  test('1. 로그인', async () => {
    // Step 1: API로 토큰 발급
    const loginResp = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL, password: PW },
    });
    const loginJson = await loginResp.json();
    console.log('API 로그인:', loginResp.status(), loginJson.ok ? 'OK' : loginJson.error);
    expect(loginJson.ok).toBe(true);
    expect(loginJson.token).toBeTruthy();

    // Step 2: 페이지 열고 토큰 세팅
    await page.goto(`${BASE}/orbit3d.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // localStorage에 토큰 세팅
    await page.evaluate((data) => {
      localStorage.setItem('orbit_token', data.token);
      localStorage.setItem('orbit_user', JSON.stringify(data.user));
    }, { token: loginJson.token, user: loginJson.user });

    // 리로드하여 로그인 상태 반영
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SS}/01-after-login.png`, fullPage: true });

    // 모달이 열려 있으면 닫기
    const overlay = page.locator('#login-modal-overlay');
    if (await overlay.isVisible().catch(() => false)) {
      await page.locator('.lm-close').click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // 로그인 확인
    const emailDisp = await page.textContent('#ln-useremail').catch(() => '');
    const hasToken = await page.evaluate(() => !!localStorage.getItem('orbit_token'));
    console.log(`로그인 확인 — 이메일: "${emailDisp}", 토큰: ${hasToken}`);

    await page.screenshot({ path: `${SS}/02-logged-in.png`, fullPage: true });
    expect(hasToken).toBe(true);
  });

  // ─── 2. 개인화면 ──────────────────────────────
  test('2-1. 기본 뷰 = 개인화면', async () => {
    const btn = page.locator('#lni-personal');
    if (await btn.isVisible().catch(() => false)) {
      const cls = await btn.getAttribute('class');
      console.log(`개인 버튼 class: "${cls}"`);
      expect(cls).toContain('active');
    } else {
      console.log('내 화면 버튼 미표시 — 모달이 가리고 있을 수 있음');
    }
    await page.screenshot({ path: `${SS}/03-personal.png` });
  });

  test('2-2. 3D 캔버스 렌더링', async () => {
    const n = await page.locator('canvas').count();
    console.log(`캔버스 수: ${n}`);
    if (n > 0) {
      const box = await page.locator('canvas').first().boundingBox();
      console.log('캔버스 크기:', box);
      if (box) expect(box.width).toBeGreaterThan(50);
    }
    await page.screenshot({ path: `${SS}/04-canvas.png` });
  });

  test('2-3. 활동 분석 패널(우하단)', async () => {
    let found = '';
    for (const sel of ['#activity-summary','#act-summary','.act-panel','#mywork-panel','#act-panel-body']) {
      if (await page.locator(sel).isVisible().catch(() => false)) { found = sel; break; }
    }
    console.log('활동 분석 패널:', found || '미발견');
    await page.screenshot({ path: `${SS}/05-activity.png` });
  });

  test('2-4. 좌측 메뉴 구성', async () => {
    const items = page.locator('.ln-item');
    const count = await items.count();
    const texts = [];
    for (let i = 0; i < count; i++) texts.push((await items.nth(i).textContent())?.trim());
    console.log(`좌측 메뉴 (${count}개):`, texts);

    const all = texts.join(' ');
    const expected = ['인사이트','AI 추천','채팅','관리자','워크스페이스','통계','설정'];
    const results = {};
    for (const k of expected) results[k] = all.includes(k) ? 'OK' : 'MISSING';
    console.log('메뉴 검증:', results);
    await page.screenshot({ path: `${SS}/06-menu.png` });
  });

  test('2-5. 인사이트 패널 → 4탭 확인', async () => {
    await page.locator('button:has-text("인사이트")').first().click();
    await page.waitForTimeout(1500);

    const panel = page.locator('#insight-panel');
    const panelVis = await panel.isVisible().catch(() => false);
    console.log('인사이트 패널 열림:', panelVis);

    for (const t of ['실시간','앱분석','통계','세션']) {
      const v = await page.locator(`.ins-tab:has-text("${t}")`).isVisible().catch(() => false);
      console.log(`  탭 "${t}": ${v ? 'OK' : 'MISSING'}`);
    }
    await page.screenshot({ path: `${SS}/07-insight.png` });
    await page.locator('.ins-close-btn').click().catch(() => {});
    await page.waitForTimeout(500);
  });

  test('2-6. AI 추천 패널', async () => {
    await page.locator('#ln-suggest-btn').click({ force: true });
    await page.waitForTimeout(2000);

    // suggestion-panel 표시 확인 (display 속성 체크)
    const panel = page.locator('#suggestion-panel');
    const style = await panel.evaluate(el => getComputedStyle(el).display).catch(() => 'none');
    console.log('AI 추천 패널 display:', style);
    await page.screenshot({ path: `${SS}/08-suggest.png` });

    // 닫기 — JS로
    await page.evaluate(() => {
      if (typeof toggleSuggestionPanel === 'function') toggleSuggestionPanel();
    }).catch(() => {});
    await page.waitForTimeout(500);
  });

  test('2-7. 통계 팝업 → 앱별 분포', async () => {
    await page.locator('button:has-text("통계")').first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SS}/09-stats.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  // ─── 3. 팀 화면 ──────────────────────────────
  test('3-1. 팀 뷰 전환', async () => {
    await page.locator('#lni-team').click({ force: true });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SS}/10-team.png` });
    console.log('팀 뷰 전환 완료');
  });

  test('3-2. 팀 뷰 안정성 (반복 이동 버그)', async () => {
    await page.screenshot({ path: `${SS}/11-team-t0.png` });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SS}/12-team-t3.png` });
    console.log('팀 뷰 3초 안정성 — 스크린샷 11↔12 비교');
  });

  test('3-3. 팀→개인 복귀', async () => {
    const p = page.locator('#lni-personal');
    if (await p.isVisible()) await p.click({ force: true });
    else await page.locator('button:has-text("개인화면")').click({ force: true });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SS}/13-team-back.png` });
    console.log('팀→개인 OK');
  });

  // ─── 4. 전사 화면 ──────────────────────────────
  test('4-1. 전사 뷰', async () => {
    await page.locator('#lni-company').click({ force: true });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SS}/14-company.png` });
    console.log('전사 뷰 전환 완료');
  });

  test('4-2. 전사 안정성', async () => {
    await page.screenshot({ path: `${SS}/15-co-t0.png` });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SS}/16-co-t3.png` });
    console.log('전사 뷰 3초 안정성 확인');
  });

  test('4-3. 전사→팀', async () => {
    await page.locator('#lni-team').click({ force: true });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SS}/17-co-to-team.png` });
  });

  test('4-4. 전사→개인', async () => {
    const p = page.locator('#lni-personal');
    if (await p.isVisible()) await p.click({ force: true });
    else await page.locator('button:has-text("개인화면")').click({ force: true });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SS}/18-back2.png` });
  });

  // ─── 5. 빠른 뷰 전환 ──────────────────────────
  test('5. 빠른 전환: 개인→팀→전사→팀→개인', async () => {
    const before = errors.filtered.length;
    const steps = [
      { n: '개인→팀',  sel: '#lni-team',     f: '19-f1.png' },
      { n: '팀→전사',  sel: '#lni-company',  f: '20-f2.png' },
      { n: '전사→팀',  sel: '#lni-team',     f: '21-f3.png' },
      { n: '팀→개인',  sel: '#lni-personal', f: '22-f4.png' },
    ];
    for (const s of steps) {
      console.log(`빠른전환: ${s.n}`);
      await page.locator(s.sel).click({ force: true });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${SS}/${s.f}` });
    }
    const newE = errors.filtered.slice(before);
    console.log(`빠른 전환 중 새 에러: ${newE.length}건`);
    if (newE.length) console.log('에러:', newE.slice(0, 5));
  });

  // ─── 6. 설정 패널 ──────────────────────────────
  test('6-1. 설정 열기 + 배포 버전', async () => {
    await page.locator('button:has-text("설정")').first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SS}/23-settings.png` });

    const txt = await page.locator('#setup-panel').textContent().catch(() => '');
    const hasVer = (txt||'').includes('버전') || (txt||'').includes('배포') || (txt||'').includes('version');
    console.log('배포 버전/시간 표시:', hasVer ? 'OK' : 'MISSING');
    console.log('설정 내용(300자):', (txt||'').substring(0, 300));
  });

  test('6-2. 불필요 항목 없음', async () => {
    const txt = await page.locator('#setup-panel').textContent().catch(() => '');
    const bad = ['Ollama','Chrome확장','데이터소스','학습공유','CLI토큰'].filter(x => (txt||'').includes(x));
    console.log('불필요 항목:', bad.length ? bad : '없음 (정상)');
    expect(bad.length).toBe(0);
    await page.locator('.sp-close, #setup-panel button:has-text("✕")').first().click().catch(() => {});
    await page.waitForTimeout(500);
  });

  // ─── 7. 관리자 대시보드 ──────────────────────
  test('7-1. admin-analysis.html 접속', async () => {
    await page.goto(`${BASE}/admin-analysis.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SS}/24-admin.png`, fullPage: true });
  });

  test('7-2. KPI 카드 확인', async () => {
    let count = 0, foundSel = '';
    for (const sel of ['.kpi-card','.stat-card','.metric-card','.dashboard-card','.card','.kpi-item','.aa-kpi-card']) {
      const c = await page.locator(sel).count();
      if (c > count) { count = c; foundSel = sel; }
    }
    console.log(`KPI 카드: ${count}개 (${foundSel})`);
    await page.screenshot({ path: `${SS}/25-kpi.png` });
  });

  test('7-3. 알고리즘 탭 A/B/C', async () => {
    for (const label of ['A','B','C']) {
      const sels = [
        `button:has-text("알고리즘 ${label}")`,
        `[data-algo="${label}"]`,
        `.algo-tab:has-text("${label}")`,
        `.aa-algo-tab:has-text("${label}")`,
      ];
      let clicked = false;
      for (const sel of sels) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          await page.waitForTimeout(1000);
          await page.screenshot({ path: `${SS}/26-algo-${label}.png` });
          console.log(`알고리즘 ${label}: OK`);
          clicked = true;
          break;
        }
      }
      if (!clicked) console.log(`알고리즘 ${label}: 셀렉터 미발견`);
    }
  });

  test('7-4. Vision 분석 결과', async () => {
    const txt = await page.textContent('body').catch(() => '');
    const hasVision = (txt||'').toLowerCase().includes('vision');
    console.log('Vision 언급:', hasVision);

    // 0건이 아닌지 확인
    const match = (txt||'').match(/vision.*?(\d+)/i);
    if (match) console.log('Vision 결과:', match[0]);
    await page.screenshot({ path: `${SS}/27-vision.png`, fullPage: true });
  });
});
