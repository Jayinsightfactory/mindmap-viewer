'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — 작업 우주 (Core: Three.js setup, mappings, clustering, controls)
// ══════════════════════════════════════════════════════════════════════════════
// ─── Three.js 기본 세팅 ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
// 사이드바 오프셋: 캔버스를 left-nav 오른쪽에서 시작
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.top = '0';
document.body.appendChild(renderer.domElement);
document.body.appendChild(OrbitVRButton.createButton(renderer));

// ── 사이드바 너비 반영 렌더 영역 계산 ─────────────────────────────────────
function getNavWidth() {
  const nav = document.getElementById('left-nav');
  if (!nav) return 0;
  return nav.classList.contains('collapsed') ? (nav.offsetWidth || 36) : (nav.offsetWidth || 200);
}

function resizeRendererToSidebar() {
  const sw = getNavWidth();
  const w  = window.innerWidth - sw;
  const h  = window.innerHeight;
  renderer.setSize(w, h);
  renderer.domElement.style.left = sw + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Label canvas 동기화
  if (typeof _labelCanvas2d !== 'undefined') {
    _labelCanvas2d.width  = w;
    _labelCanvas2d.height = h;
    _labelCanvas2d.style.left = sw + 'px';
  }
}
window.resizeRendererToSidebar = resizeRendererToSidebar;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x060a10);
scene.fog = new THREE.FogExp2(0x060a10, 0.004);

const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 2000);
camera.position.set(0, 25, 55);                       // 컴팩트 뷰에 맞는 초기 거리
camera.lookAt(0,0,0);

// ─── 조명 ─────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const sun = new THREE.PointLight(0xffd080, 3, 400);
scene.add(sun);
const rimLight = new THREE.PointLight(0x58a6ff, 1.2, 300);
rimLight.position.set(-100,80,-80);
scene.add(rimLight);

// ─── 별 배경 ──────────────────────────────────────────────────────────────────
(function () {
  const geo = new THREE.BufferGeometry();
  const N = 4000, pos = new Float32Array(N*3), col = new Float32Array(N*3);
  for (let i=0; i<N; i++) {
    const r = 600 + Math.random()*400;
    const θ = Math.random()*Math.PI*2, φ = Math.acos(2*Math.random()-1);
    pos[i*3]   = r*Math.sin(φ)*Math.cos(θ);
    pos[i*3+1] = r*Math.sin(φ)*Math.sin(θ);
    pos[i*3+2] = r*Math.cos(φ);
    const c = new THREE.Color().setHSL(Math.random(), 0.2+Math.random()*0.3, 0.5+Math.random()*0.4);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col,3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({size:0.6, vertexColors:true, transparent:true, opacity:0.7})));
})();

// ─── 타입 → 색상 / 의미 매핑 ─────────────────────────────────────────────────
const TYPE_CFG = {
  'user.message':       { color:0x58a6ff, cat:'chat',  label:'질문',     icon:'💬' },
  'assistant.message':  { color:0xbc8cff, cat:'chat',  label:'AI 답변',  icon:'🤖' },
  'assistant.response': { color:0xbc8cff, cat:'chat',  label:'AI 답변',  icon:'🤖' },
  'app.activity':       { color:0x39d2c0, cat:'code',  label:'앱 활동',  icon:'📱' },
  'app_switch':         { color:0x39d2c0, cat:'code',  label:'앱 전환',  icon:'🔄' },
  'browse':             { color:0x58a6ff, cat:'code',  label:'브라우저',  icon:'🌐' },
  'browser_activity':   { color:0x58a6ff, cat:'code',  label:'브라우저',  icon:'🌐' },
  'tool.start':         { color:0x3fb950, cat:'code',  label:'실행 시작', icon:'⚡' },
  'tool.end':           { color:0x3fb950, cat:'code',  label:'실행 완료', icon:'✅' },
  'tool.error':         { color:0xf85149, cat:'error', label:'실행 오류', icon:'❌' },
  'file.read':          { color:0xffa657, cat:'file',  label:'파일 읽기', icon:'📄' },
  'file.write':         { color:0xffa657, cat:'file',  label:'파일 수정', icon:'✏️' },
  'file.create':        { color:0xffa657, cat:'file',  label:'파일 생성', icon:'🆕' },
  'git.commit':         { color:0x39d2c0, cat:'git',   label:'Git 커밋',  icon:'🌿' },
  'git.push':           { color:0x79c0ff, cat:'git',   label:'Git 푸시',  icon:'🚀' },
  'session.start':      { color:0xffd700, cat:'chat',  label:'세션 시작', icon:'🌟' },
  'task.complete':      { color:0x3fb950, cat:'code',  label:'작업 완료', icon:'🏁' },
  'default':            { color:0x3d444d, cat:'chat',  label:'기타',      icon:'·'  },
};
function typeCfg(t) { return TYPE_CFG[t] || TYPE_CFG.default; }

// ─── 파일 용도 추론 (파일명 → 역할 설명) ─────────────────────────────────────
function inferFileRole(filename) {
  if (!filename) return null;
  const f = filename.toLowerCase();
  const name = f.replace(/\.[^.]+$/, ''); // 확장자 제거

  // 인프라 / 설정
  if (/docker|compose/.test(name))          return '🐳 컨테이너';
  if (/\.env|config|setting|conf/.test(f))  return '⚙️ 설정';
  if (/package\.json/.test(f))              return '📦 의존성';
  if (/tsconfig|jsconfig/.test(f))          return '🔧 TS 설정';
  if (/eslint|prettier|lint/.test(f))       return '✨ 코드 품질';
  if (/webpack|vite|rollup|babel/.test(f))  return '⚡ 빌드';

  // 인증 / 보안
  if (/auth|login|oauth|jwt|token|session|password/.test(name)) return '🔐 인증';
  if (/security|cors|helmet|csrf/.test(name))                   return '🛡️ 보안';

  // DB / 스토어
  if (/db|database|schema|migration|model|store|entity/.test(name)) return '🗄️ 데이터';
  if (/redis|mongo|postgres|sqlite|mysql/.test(name))               return '🗄️ DB';

  // API / 라우터
  if (/route|router|api|endpoint|controller/.test(name)) return '🌐 API';
  if (/middleware|interceptor/.test(name))                return '🔀 미들웨어';
  if (/server|app\.js|main|index/.test(f))               return '🚀 서버';

  // UI
  if (/component|widget|ui|view|page|screen/.test(name)) return '🎨 UI';
  if (/style|css|scss|tailwind/.test(f))                 return '🎨 스타일';
  if (/layout|template/.test(name))                      return '📐 레이아웃';

  // 유틸 / 서비스
  if (/util|helper|lib|tool|service/.test(name)) return '🔩 유틸';
  if (/hook|context|store|state/.test(name))     return '🔄 상태';

  // 테스트
  if (/test|spec|e2e|jest|vitest/.test(f)) return '🧪 테스트';

  // 문서
  if (/readme|doc|md$/.test(f)) return '📝 문서';

  // 확장자 기반 fallback
  if (f.endsWith('.ts') || f.endsWith('.js')) return '📜 스크립트';
  if (f.endsWith('.tsx') || f.endsWith('.jsx')) return '⚛️ 컴포넌트';
  if (f.endsWith('.html')) return '🌐 페이지';
  if (f.endsWith('.json')) return '📋 데이터';
  if (f.endsWith('.sh'))   return '⚡ 스크립트';
  if (f.endsWith('.sql'))  return '🗄️ SQL';

  return null; // 추론 불가 → 파일명 그대로 사용
}

// ─── 의도(Intent) 추출 ────────────────────────────────────────────────────────
function extractIntent(node) {
  // 이미 label이 있으면 우선 사용 (API 반환 데이터)
  if (node.label && node.label !== node.type) return node.label;
  const t = node.type || '';

  // fullContent에서 data 파싱
  let d = node.data || {};
  const fc = node.fullContent;
  if (fc && typeof fc === 'string' && fc.startsWith('{')) {
    try { d = { ...d, ...JSON.parse(fc) }; } catch {}
  }

  if (t === 'user.message') {
    const txt = d.contentPreview || d.content || '';
    return txt ? txt.slice(0,38) : '질문';
  }
  if (t === 'assistant.message' || t === 'assistant.response') {
    const txt = d.contentPreview || d.content || '';
    return txt ? txt.slice(0,38) : 'AI 답변';
  }
  if (t === 'tool.end' || t === 'tool.start') {
    const tool = d.toolName || '';
    const file = (d.filePath||'').replace(/\\/g,'/').split('/').pop();
    const role = file ? inferFileRole(file) : null;
    const TOOLS = {
      'Write':'작성', 'Edit':'수정', 'Read':'읽기',
      'Bash':'실행', 'Grep':'검색', 'Glob':'탐색',
      'Task':'에이전트', 'WebFetch':'웹 조회',
    };
    const tl = TOOLS[tool] || tool;
    if (role && file) return `${role} ${tl}`;
    return file ? `${tl}: ${file}` : (tl || t);
  }
  if (t === 'file.write' || t === 'file.create') {
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    const role = inferFileRole(f);
    return role ? `${role} 수정` : (f ? `✏️ ${f}` : '파일 수정');
  }
  if (t === 'file.read') {
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    const role = inferFileRole(f);
    return role ? `${role} 읽기` : (f ? `📄 ${f}` : '파일 읽기');
  }
  if (t === 'git.commit') return d.message ? d.message.slice(0,36) : 'Git 커밋';
  if (t === 'task.complete') return d.taskName || '작업 완료';
  if (t === 'session.start') return '세션 시작';

  // ── 외부 활동 이벤트 → 작업 설명 변환 ─────────────────────────────────────
  if (t === 'terminal.command') {
    const cmd = (d.command || '').trim();
    if (!cmd) return '⚡ 터미널';
    // 명령어 → 작업 의미 변환
    if (/^(git\s+(push|pull|merge|rebase))/.test(cmd)) return '🌿 ' + cmd.slice(0,30);
    if (/^git\s+commit/.test(cmd))  return '📦 커밋: ' + (cmd.match(/-m\s+["']?(.+?)["']?$/)?.[1] || '').slice(0,24);
    if (/^(npm|yarn|pnpm)\s+(install|add)/.test(cmd)) return '📥 패키지 설치';
    if (/^(npm|yarn)\s+(run\s+)?(test|jest|vitest)/.test(cmd)) return '🧪 테스트 실행';
    if (/^(npm|yarn)\s+(run\s+)?(build|compile)/.test(cmd)) return '🏗️ 빌드';
    if (/^(npm|yarn)\s+(run\s+)?(dev|start)/.test(cmd)) return '🚀 서버 시작';
    if (/^(docker|docker-compose)/.test(cmd)) return '🐳 Docker: ' + cmd.slice(0,24);
    if (/^(cd|ls|dir|cat|echo)/.test(cmd)) return '📂 탐색: ' + cmd.slice(0,24);
    if (/^(curl|wget|fetch)/.test(cmd)) return '🌐 HTTP 요청';
    if (/^(ssh|scp|rsync)/.test(cmd)) return '🔗 원격 접속';
    return '⚡ ' + cmd.slice(0,30);
  }
  if (t.startsWith('vscode.')) {
    const sub = t.replace('vscode.', '');
    const file = (d.fileName || d.filePath || '').replace(/\\/g,'/').split('/').pop();
    if (sub === 'file.open' || sub === 'activeEditor')  return file ? `📝 편집: ${file}` : '📝 VS Code 편집';
    if (sub === 'file.save')     return file ? `💾 저장: ${file}` : '💾 파일 저장';
    if (sub === 'debug.start')   return '🐛 디버깅 시작';
    if (sub === 'terminal')      return '⚡ VS Code 터미널';
    if (sub === 'extension')     return '🧩 확장 사용: ' + (d.extensionId || '').slice(0,20);
    return '💻 VS Code: ' + sub;
  }
  if (t === 'browser_activity' || t === 'browse') {
    const title = (d.title || '').slice(0,30);
    const url   = d.url || '';
    if (/stackoverflow|github.*issue|reddit/.test(url))    return '🔍 문제 해결: ' + title;
    if (/github\.com.*\/pull/.test(url))                   return '🔀 PR 리뷰: ' + title;
    if (/github\.com/.test(url))                           return '🐙 GitHub: ' + title;
    if (/docs\.|documentation|mdn|devdocs/.test(url))      return '📚 문서 참조: ' + title;
    if (/chatgpt|claude|bard|gemini|perplexity/.test(url)) return '🤖 AI 대화: ' + title;
    if (/youtube|udemy|coursera/.test(url))                return '🎓 학습: ' + title;
    if (/figma|canva|design/.test(url))                    return '🎨 디자인: ' + title;
    if (/jira|linear|notion|trello/.test(url))             return '📋 프로젝트 관리: ' + title;
    if (/slack|discord|teams/.test(url))                   return '💬 소통: ' + title;
    if (/mail\.|gmail|outlook/.test(url))                  return '📧 이메일: ' + title;
    if (/google\.(com|co).*\/search/.test(url))            return '🔍 검색: ' + title;
    return title ? '🌐 ' + title : '🌐 브라우저';
  }
  // ── 시스템 모니터: 앱 전환 이벤트 → 작업 설명 ────────────────────────────
  if (t === 'app_switch') {
    const app   = (d.app || '').toLowerCase();
    const title = (d.title || '').slice(0,30);
    const cat   = d.category || '';
    if (/chrome|edge|firefox|safari|brave/i.test(app))     return title ? '🌐 ' + title : '🌐 브라우저';
    if (/vscode|cursor|zed|sublime|idea/i.test(app))       return title ? '💻 ' + title : '💻 코드 편집';
    if (/word|한글|hwp|pages|docs/i.test(app))             return title ? '📝 ' + title : '📝 문서 작성';
    if (/excel|numbers|sheets|calc/i.test(app))            return title ? '📊 ' + title : '📊 스프레드시트';
    if (/powerpoint|keynote|impress/i.test(app))           return title ? '📊 ' + title : '📊 프레젠테이션';
    if (/zoom|teams|meet|webex|slack|discord/i.test(app))  return title ? '💬 ' + title : '💬 미팅/소통';
    if (/notion|obsidian|bear|evernote/i.test(app))        return title ? '📝 ' + title : '📝 노트 작성';
    if (/terminal|iterm|warp|hyper|powershell|cmd/i.test(app)) return title ? '⚡ ' + title : '⚡ 터미널';
    if (/figma|sketch|xd|illustrator|photoshop/i.test(app)) return title ? '🎨 ' + title : '🎨 디자인';
    if (/mail|outlook|thunderbird/i.test(app))             return title ? '📧 ' + title : '📧 이메일';
    return title ? `📱 ${app}: ${title}` : `📱 ${app || '앱 전환'}`;
  }
  // ── app.activity (DB에 저장된 시스템 모니터 이벤트) ───────────────────
  if (t === 'app.activity') {
    const app   = (d.app || '').toLowerCase();
    const title = (d.title || '').slice(0,30);
    const url   = d.url || '';
    if (url) {
      // URL 기반 분류 (browse 타입과 동일)
      if (/stackoverflow|github.*issue|reddit/.test(url))    return '🔍 문제 해결: ' + title;
      if (/github\.com.*\/pull/.test(url))                   return '🔀 PR 리뷰: ' + title;
      if (/github\.com/.test(url))                           return '🐙 GitHub: ' + title;
      if (/docs\.|documentation|mdn|devdocs/.test(url))      return '📚 문서 참조: ' + title;
      if (/chatgpt|claude|bard|gemini|perplexity/.test(url)) return '🤖 AI 대화: ' + title;
      return title ? '🌐 ' + title : '🌐 브라우저';
    }
    if (/vscode|cursor|zed|sublime|idea/i.test(app))       return title ? '💻 ' + title : '💻 코드 편집';
    if (/chrome|edge|firefox|safari|brave/i.test(app))     return title ? '🌐 ' + title : '🌐 브라우저';
    if (/zoom|teams|meet|slack|discord/i.test(app))        return title ? '💬 ' + title : '💬 소통';
    if (/terminal|iterm|warp|powershell|cmd/i.test(app))   return title ? '⚡ ' + title : '⚡ 터미널';
    return title ? `📱 ${title}` : (app ? `📱 ${app}` : '📱 앱 활동');
  }
  if (t === 'keylog_insight') {
    const topic = d.topic || d.activity || '';
    if (topic) return '⌨️ ' + topic.slice(0,30);
    return '⌨️ 키 입력 분석';
  }
  if (t === 'ai_tool_event') {
    const tool = d.tool || '';
    const topic = (d.topic || '').slice(0,24);
    return topic ? `🤖 ${tool}: ${topic}` : `🤖 ${tool || 'AI'} 사용`;
  }

  return d.toolName || d.contentPreview || t;
}

// ─── 파일 위성 집계 (세션별 편집 파일 → 용도 태그 목록) ─────────────────────
function buildFileSatellites(events) {
  const fileCounts = {};
  for (const e of events) {
    // data 또는 fullContent에서 filePath 추출
    let d = e.data || {};
    const fc = e.fullContent;
    if (fc && typeof fc === 'string' && fc.startsWith('{')) {
      try { d = { ...d, ...JSON.parse(fc) }; } catch {}
    } else if (fc && typeof fc === 'string' && fc.includes('/')) {
      d = { ...d, filePath: fc };
    }
    const rawPath = d.filePath || d.fileName || '';
    if (!rawPath) continue;
    const fname = rawPath.replace(/\\/g, '/').split('/').pop();
    if (!fname || fname.length < 2) continue;
    if (!fileCounts[fname]) fileCounts[fname] = { count:0, types: new Set() };
    fileCounts[fname].count++;
    fileCounts[fname].types.add(e.type);
  }
  // 상위 12개, 용도 추론
  return Object.entries(fileCounts)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([fname, info]) => {
      const role = inferFileRole(fname);
      // 실제 파일명(확장자 포함) 우선 표시, 역할 아이콘은 앞에 prefix
      const shortName = fname.split('/').pop(); // 경로 제거, 파일명만
      const roleIcon  = role ? role.split(' ')[0] : '📄'; // 이모지만 추출
      return {
        label:    `${roleIcon} ${shortName}`,  // "📋 server.js" 형식
        roleDesc: role || '파일',              // 역할 설명 (툴팁용)
        filename: fname,
        count:    info.count,
        isWrite:  info.types.has('file.write') || info.types.has('tool.end'),
      };
    });
}

// ─── 목적 기반 클러스터링 ─────────────────────────────────────────────────────
// 세션이 1개여도 이벤트를 "목적/의도 도메인"으로 묶어 복수 행성으로 표시
function clusterByIntent(sessionId, events) {
  // ── 1. purposeLabel이 있으면 최우선 활용 ──────────────────────────────────
  const hasPurpose = events.some(e => e.purposeLabel);

  if (hasPurpose) {
    const purposeMap = {};
    for (const ev of events) {
      const key = ev.purposeLabel || '⚙️ 기타';
      if (!purposeMap[key]) {
        purposeMap[key] = {
          clusterId:  `${sessionId}__${key}`,
          sessionId,
          domain:     'purpose',
          label:      key,
          icon:       ev.purposeIcon || '⚙️',
          color:      ev.purposeColor || '#8b949e',
          msgPreview: '',
          events:     [],
        };
      }
      purposeMap[key].events.push(ev);
    }

    // 첫 user.message 프리뷰 보강
    for (const cluster of Object.values(purposeMap)) {
      const msg = cluster.events.find(e => e.type === 'user.message');
      cluster.msgPreview = (msg?.label || '').slice(0, 26);
    }

    return Object.values(purposeMap).sort((a, b) => b.events.length - a.events.length);
  }

  // ── 2. purposeLabel 없으면 파일경로/라벨/타입 기반 도메인 분류 ────────────
  function getDomain(ev) {
    const t = ev.type || '';

    // fullContent JSON에서 filePath 추출
    let fp = '';
    const fc = ev.fullContent || ev.label || '';
    if (typeof fc === 'string' && fc.startsWith('{')) {
      try { fp = JSON.parse(fc).filePath || ''; } catch {}
    } else if (typeof fc === 'string' && fc.includes('/')) {
      fp = fc;
    }
    // label에서 파일명 추출 ("파일 작성: auth.js" 형태)
    const labelFile = (ev.label || '').match(/[:\s]+([^\s:]+\.[a-z]+)/i)?.[1] || '';
    const fname = (fp || labelFile).replace(/\\/g, '/').split('/').pop().toLowerCase();

    if (/auth|login|oauth|jwt|token|session|password/.test(fname)) return 'auth';
    if (/route|router|api|endpoint|controller/.test(fname))        return 'api';
    if (/db|database|schema|migration|model|store|entity/.test(fname)) return 'data';
    if (/component|widget|ui|view|page|screen|style|css/.test(fname))  return 'ui';
    if (/test|spec|e2e|jest|vitest/.test(fname))                        return 'test';
    if (/server|app\.js|main|index/.test(fname))                        return 'server';
    if (/docker|compose|deploy|ci|cd|yml|yaml/.test(fname))            return 'infra';
    if (/doc|readme|md$/.test(fname))                                   return 'docs';

    // label/대화 기반
    const txt = (ev.label || '').toLowerCase();
    if (/버그|오류|에러|fix|bug|error/.test(txt))      return 'fix';
    if (/설계|구조|아키텍|design|architect/.test(txt)) return 'design';
    if (/배포|deploy|release|publish/.test(txt))        return 'infra';
    if (/테스트|test|spec/.test(txt))                   return 'test';

    if (t === 'user.message' || t === 'assistant.message' || t === 'assistant.response') return 'chat';
    if (t === 'git.commit' || t === 'git.push') return 'git';
    if (t === 'tool.error') return 'fix';
    if (t === 'terminal.command') return 'server';
    if (t.startsWith('vscode.')) return 'ui';
    if (t === 'browser_activity' || t === 'browse') {
      const url = (ev.data?.url || '').toLowerCase();
      if (/docs\.|mdn|devdocs|stackoverflow/.test(url)) return 'docs';
      if (/chatgpt|claude|bard|gemini/.test(url)) return 'chat';
      if (/figma|canva/.test(url)) return 'ui';
      if (/github\.com|gitlab|bitbucket/.test(url)) return 'api';
      if (/jira|linear|asana|trello|notion/.test(url)) return 'design';
      if (/mail\.|gmail|outlook/.test(url)) return 'docs';
      return 'general';
    }
    if (t === 'app_switch') {
      const app = (ev.data?.app || '').toLowerCase();
      if (/vscode|cursor|zed|sublime|idea/i.test(app)) return 'ui';
      if (/terminal|iterm|warp|powershell|cmd/i.test(app)) return 'server';
      if (/chrome|edge|firefox|safari|brave/i.test(app)) return 'general';
      if (/zoom|teams|meet|slack|discord/i.test(app)) return 'docs';
      if (/figma|sketch|xd|photoshop|illustrator/i.test(app)) return 'ui';
      if (/word|한글|hwp|pages|notion|obsidian/i.test(app)) return 'docs';
      return 'general';
    }
    if (t === 'app.activity') {
      const app2 = (ev.data?.app || '').toLowerCase();
      const url2 = (ev.data?.url || '').toLowerCase();
      if (url2) {
        if (/docs\.|mdn|devdocs|stackoverflow/.test(url2)) return 'docs';
        if (/github\.com|gitlab|bitbucket/.test(url2)) return 'api';
        if (/chatgpt|claude|bard|gemini/.test(url2)) return 'chat';
        if (/figma|canva/.test(url2)) return 'ui';
        return 'general';
      }
      if (/vscode|cursor|zed|sublime|idea/i.test(app2)) return 'ui';
      if (/terminal|iterm|warp|powershell|cmd/i.test(app2)) return 'server';
      return 'general';
    }
    if (t === 'keylog_insight' || t === 'ai_tool_event') return 'chat';

    return 'general';
  }

  const DOMAIN_LABELS = {
    auth:     '🔐 인증 구현',  api:   '🌐 API 개발',
    data:     '🗄️ 데이터',    ui:    '🎨 UI 작업',
    test:     '🧪 테스트',     server:'🚀 서버 개발',
    infra:    '🐳 인프라',     docs:  '📝 문서화',
    design:   '📐 설계 논의',  fix:   '🔧 버그 수정',
    git:      '🌿 Git 관리',   chat:  '💬 대화',
    general:  '⚙️ 일반 작업',
  };

  const domainMap = {};
  for (const ev of events) {
    const domain = getDomain(ev);
    if (!domainMap[domain]) domainMap[domain] = [];
    domainMap[domain].push(ev);
  }

  // 너무 작은 클러스터는 general로 병합
  const minSize = Math.max(2, Math.floor(events.length * 0.04));
  const merged = {};
  for (const [domain, evs] of Object.entries(domainMap)) {
    const target = (evs.length <= minSize && domain !== 'general') ? 'general' : domain;
    if (!merged[target]) merged[target] = [];
    merged[target].push(...evs);
  }

  const clusters = [];
  for (const [domain, evs] of Object.entries(merged)) {
    // 첫 user.message에서 실제 작업 내용 추출
    const msg = evs.find(e => e.type === 'user.message');
    let msgText = '';
    if (msg) {
      const d = msg.data || {};
      msgText = (d.contentPreview || d.content || msg.label || '').slice(0, 30);
    }
    // git commit 메시지도 후보로 활용
    if (!msgText) {
      const gitEv = evs.find(e => e.type === 'git.commit');
      msgText = (gitEv?.data?.message || '').slice(0, 30);
    }
    // 라벨: 작업 설명이 있으면 도메인 라벨 + 설명 조합
    const domainLabel = DOMAIN_LABELS[domain] || '⚙️ 작업';
    const label = msgText ? `${domainLabel}  ${msgText}` : domainLabel;

    clusters.push({
      clusterId:  `${sessionId}__${domain}`,
      sessionId,
      domain,
      label,
      msgPreview: msgText,
      events:     evs,
    });
  }

  clusters.sort((a, b) => b.events.length - a.events.length);
  return clusters;
}

// ─── 세션 컨텍스트 캐시 (비동기 로드) ────────────────────────────────────────
const _sessionContextCache = {};   // sessionId → { autoTitle, projectName, firstMsg, topFile }

async function loadSessionContext(sessionId) {
  if (_sessionContextCache[sessionId]) return _sessionContextCache[sessionId];
  try {
    const r = await fetch(`/api/sessions/${sessionId}/context`);
    if (!r.ok) return null;
    const ctx = await r.json();
    _sessionContextCache[sessionId] = ctx;
    // 행성 라벨 즉시 업데이트 — AI 라벨 우선, autoTitle 폴백
    const _isMeaningful = t => t && !/^(세션\s|⚙️\s?작업\s?중|작업\s?중|\[.*\]\s*$)/.test(t);
    const planet = _sessionMap[sessionId]?.planet;
    if (planet) {
      // AI 라벨이 있으면 최우선 사용
      if (ctx.aiLabel && _isMeaningful(ctx.aiLabel)) {
        planet.userData.intent = ctx.aiLabel;
      } else if (_isMeaningful(ctx.autoTitle)) {
        planet.userData.intent = ctx.autoTitle;
      }
      // AI 매크로 카테고리 업데이트
      if (ctx.aiCat && ['dev', 'research', 'ops'].includes(ctx.aiCat)) {
        planet.userData.macroCat = ctx.aiCat;
      }
      if (ctx.projectName) {
        const oldProj = planet.userData.projectName;
        const newProj = ctx.projectName;
        if (oldProj !== newProj) {
          planet.userData.projectName = newProj;
          // _projectGroups 재구성
          _projectGroups = {};
          planetMeshes.forEach(p => {
            const proj = p.userData.projectName || '기타';
            if (!_projectGroups[proj]) _projectGroups[proj] = { planetMeshes: [], color: p.userData.hueHex || '#58a6ff' };
            _projectGroups[proj].planetMeshes.push(p);
          });
        }
      }
    }
    return ctx;
  } catch { return null; }
}

// 세션의 대표 의도 (로컬 이벤트 기반 — 비동기 컨텍스트 로드 전 임시값)
function sessionIntent(events) {
  const sid = events[0]?.sessionId;

  // 이미 캐시됐으면 사용
  if (sid && _sessionContextCache[sid]) return _sessionContextCache[sid].autoTitle;

  // session.start의 data.title (수동 설정 우선)
  const sessStart = events.find(e => e.type === 'session.start');
  if (sessStart?.data?.title) return sessStart.data.title;

  // projectDir 폴더명
  const pd = sessStart?.data?.projectDir;
  const projectName = pd ? pd.replace(/\\/g,'/').split('/').filter(Boolean).pop() : null;

  // 파일 편집 횟수 집계
  const fileCounts = {};
  for (const e of events) {
    const d = e.data || {};
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    if (f) fileCounts[f] = (fileCounts[f]||0) + 1;
  }
  const topFile = Object.entries(fileCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  // 첫 user.message — fullContent JSON에서도 content 추출 시도
  const msg = events.find(e => e.type === 'user.message');
  let firstMsg = null;
  if (msg) {
    let md = msg.data || {};
    const mfc = msg.fullContent;
    if (mfc && typeof mfc === 'string' && mfc.startsWith('{')) {
      try { md = { ...md, ...JSON.parse(mfc) }; } catch {}
    }
    firstMsg = (md.contentPreview || md.content || msg.label || '').slice(0, 36) || null;
  }
  // git commit 메시지도 후보
  if (!firstMsg) {
    const gitMsg = events.find(e => e.type === 'git.commit');
    firstMsg = (gitMsg?.data?.message || '').slice(0, 36) || null;
  }

  // ── 브라우저/앱 활동 세션 → 도메인 라벨 (작업 설명 우선) ─────────────────
  const browseEvs = events.filter(e => e.type === 'browser_activity' || e.type === 'browse' || e.type === 'app_switch');
  let domainLabel = null;
  if (browseEvs.length > 0) {
    const latest = browseEvs[browseEvs.length - 1];
    const latentLabel = extractIntent(latest);
    if (latentLabel && latentLabel !== '🌐 브라우저') {
      const uniqueApps = new Set(browseEvs.map(e => (e.data?.app || e.data?.title || '').slice(0,20)));
      const appCount = uniqueApps.size;
      domainLabel = appCount > 1 ? `${latentLabel} (+${appCount - 1}개 작업)` : latentLabel;
    }
  }
  if (!domainLabel && sid) {
    const cls = clusterByIntent(sid, events);
    const best = cls.find(c => c.domain !== 'general') || cls[0];
    if (best?.label) domainLabel = best.label;
  }

  // 조합 우선순위: firstMsg → domainLabel → topFile
  if (projectName && firstMsg)    return `[${projectName}] ${firstMsg}`;
  if (projectName && domainLabel) return `[${projectName}] ${domainLabel}`;
  if (projectName && topFile)     return `[${projectName}] ${topFile}`;
  if (projectName)                return projectName;
  if (firstMsg)                   return firstMsg;
  if (domainLabel)                return domainLabel;
  if (topFile)                    return topFile;

  // 도메인 라벨 폴백
  if (sid) {
    // 세션명 readable 변환 (UUID가 아닌 경우, 'session' prefix 제거)
    if (!/^[0-9a-f]{8}-/.test(sid) && sid.length <= 30) {
      const parts = sid.split(/[-_]/).filter(s => s && s !== 'session' && s !== 'wf');
      if (parts.length > 0) {
        return parts.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ').slice(0, 30);
      }
    }
  }
  return '⚙️ 작업 중';
}

// ─── OrbitControls 인라인 ─────────────────────────────────────────────────────
class OrbitCam {
  constructor(cam, el) {
    this.cam = cam; this.el = el;
    this.tgt = new THREE.Vector3();
    this.sph = { r:55, θ:0.3, φ:1.1 };                  // 컴팩트 뷰 기본 거리
    this._d = false; this._r = false; this._lx=0; this._ly=0;
    this._dragging = false; // 드래그 중 플래그 (자동전환 방지)
    el.addEventListener('mousedown',  e => { this._lx=e.clientX; this._ly=e.clientY; e.button===2?this._r=true:this._d=true; this._dragging=true; });
    el.addEventListener('mousemove',  e => this._move(e));
    el.addEventListener('mouseup',    () => { this._d=this._r=false; this._dragging=false; });
    el.addEventListener('wheel', e => {
      // 줌 감도 낮춤 (0.08 → 0.04) + 부드러운 줌
      this.sph.r = Math.max(4, Math.min(300, this.sph.r + e.deltaY * 0.04));
      this._apply();
    }, {passive:true});
    el.addEventListener('dblclick',   e => this._dbl(e));
    el.addEventListener('contextmenu',e => e.preventDefault());
    this._apply();
  }
  _move(e) {
    const dx=e.clientX-this._lx, dy=e.clientY-this._ly;
    this._lx=e.clientX; this._ly=e.clientY;
    if (this._d) {
      // 회전 감도 약간 낮춤 (0.004 → 0.003) — 더 정밀한 조작
      this.sph.θ -= dx*.003;
      this.sph.φ = Math.max(.05, Math.min(Math.PI-.05, this.sph.φ+dy*.003));
    } else if (this._r) {
      // 팬 감도 낮춤 (0.05 → 0.03)
      const fwd = new THREE.Vector3(); this.cam.getWorldDirection(fwd);
      const right = new THREE.Vector3().crossVectors(fwd, this.cam.up).normalize();
      this.tgt.addScaledVector(right, -dx*.03).addScaledVector(this.cam.up, dy*.03);
    }
    this._apply();
  }
  _dbl(e) {
    // 더블클릭: hitTest 기반으로 선택 노드에 줌인
    const hit = hitTest(e.clientX, e.clientY);
    if (hit && hit.obj?.position) {
      this.tgt.copy(hit.obj.position);
      this.sph.r = 40; this._apply();
    }
  }
  _apply() {
    const {r,θ,φ}=this.sph;
    this.cam.position.set(
      this.tgt.x + r*Math.sin(φ)*Math.sin(θ),
      this.tgt.y + r*Math.cos(φ),
      this.tgt.z + r*Math.sin(φ)*Math.cos(θ),
    );
    this.cam.lookAt(this.tgt);
  }
}

const _raycaster = new THREE.Raycaster();
const controls   = new OrbitCam(camera, renderer.domElement);

// ─── 씬 오브젝트 ──────────────────────────────────────────────────────────────
// 행성/위성은 "보이지 않는 Three.js Object3D"로 위치만 관리
// 실제 렌더링은 Canvas2D drawLabels()가 담당
let planetMeshes    = [];   // Object3D (invisible) — 위치 추적용
let satelliteMeshes = [];   // Object3D (invisible) — 위치 추적용
let orbitRings      = [];   // Mesh — 궤도 링 (Three.js)
let connections     = [];   // Line — 연결선 (Three.js, 희미하게)
let labelSprites    = [];   // unused legacy

let _allNodes   = [];
let _sessionMap = {};   // sessionId → { planet:Object3D, fileSats:[], events:[] }
let _nodeDataMap = {};  // uuid → data for interaction

let orbitAnimOn = true;
let _clock = 0;

// 호버/클릭을 위한 2D 히트 영역 (Canvas 좌표)
let _hitAreas = []; // { cx, cy, r, data }

// ── 프로젝트별 별자리 클러스터링 ─────────────────────────────────────────────
let _projectGroups  = {};   // projectName → { planetMeshes:[], color:string }
let _focusedProject = null; // null=별자리 전체 뷰, 'name'=특정 프로젝트 집중

// ── 3대 카테고리 시스템 (기능구현 / 조사분석 / 배포운영) ─────────────────────
const MACRO_CATS = {
  dev:      { label: '기능구현', color: '#58a6ff', angle: 0 },             // 오른쪽
  research: { label: '조사분석', color: '#d2a8ff', angle: (Math.PI * 2) / 3 },  // 왼쪽 위
  ops:      { label: '배포운영', color: '#3fb950', angle: (Math.PI * 4) / 3 },  // 왼쪽 아래
};
let _categoryGroups = {};   // 'dev'|'research'|'ops' → { projects:{}, planets:[], color }
let _focusedCategory = null; // null=전체뷰, 'dev'|'research'|'ops'=카테고리 집중

// ── 이벤트 기반 매크로 카테고리 분류 ──────────────────────────────────────────
function classifyMacroCategory(events) {
  let dev = 0, research = 0, ops = 0;
  for (const e of events) {
    const t = e.type || '';
    const d = e.data || {};
    const tool = d.toolName || '';
    // 기능구현: 파일 작성/수정, 코딩
    if (t === 'file.write' || t === 'file.create') dev += 3;
    if (t === 'tool.end' && /^(Write|Edit)$/.test(tool)) dev += 3;
    if (t === 'task.complete') dev += 2;
    // 조사분석: 파일 읽기, 검색, 대화, 브라우저
    if (t === 'file.read') research += 1;
    if (t === 'tool.end' && /^(Read|Grep|Glob|WebFetch|WebSearch)$/.test(tool)) research += 2;
    if (t === 'user.message') research += 1;
    if (t === 'assistant.message' || t === 'assistant.response') research += 1;
    if (t === 'browser_activity' || t === 'browse' || t === 'app_switch' || t === 'app.activity') research += 2;
    // 배포운영: git, 터미널, 인프라
    if (t === 'git.commit' || t === 'git.push') ops += 3;
    if (t === 'terminal.command') ops += 2;
    if (t === 'tool.end' && /^Bash$/.test(tool)) ops += 1;
  }
  if (dev >= research && dev >= ops) return 'dev';
  if (research >= ops) return 'research';
  return 'ops';
}

let _activeFilter = 'all';
const FILTER_CATS = {
  all:  null,
  code: ['code'],
  file: ['file'],
  chat: ['chat'],
  git:  ['git'],
};

function setFilter(f, btn) {
  if (typeof track === 'function') track('view.filter_change', { filter_type: 'node', value: f });
  _activeFilter = f;
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  buildPlanetSystem(_allNodes);
}
window.setFilter = setFilter;

function toggleOrbitAnim() {
  orbitAnimOn = !orbitAnimOn;
  const oldBtn = document.getElementById('orbit-toggle-btn');
  if (oldBtn) oldBtn.textContent = orbitAnimOn ? '⏸ 애니 중지' : '▶ 애니 시작';
  const upBtn = document.getElementById('up-orbit-btn');
  if (upBtn) upBtn.textContent = orbitAnimOn ? '⏸ 애니 중지' : '▶ 애니 시작';
}
window.toggleOrbitAnim = toggleOrbitAnim;

// ─── 휠 줌 기반 뷰 자동 전환 ─────────────────────────────────────────────────
// 비활성화: 자동 전환이 마우스 조작 중 예기치 않은 점프를 유발함
// 뷰 전환은 UI 버튼(팀뷰/전사뷰)으로만 수동 전환
function _autoSwitchViewByZoom() {
  // 의도적으로 비활성화 — 사용자가 직접 뷰 버튼으로 전환
}

