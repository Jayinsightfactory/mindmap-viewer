// i18n.js — Orbit AI 다국어 지원 (한국어/스페인어)
(function() {
  const TRANSLATIONS = {
    // Common UI
    'dashboard': { ko: '대시보드', es: 'Panel' },
    'settings': { ko: '설정', es: 'Configuración' },
    'login': { ko: '로그인', es: 'Iniciar sesión' },
    'logout': { ko: '로그아웃', es: 'Cerrar sesión' },
    'save': { ko: '저장', es: 'Guardar' },
    'cancel': { ko: '취소', es: 'Cancelar' },
    'search': { ko: '검색', es: 'Buscar' },
    'loading': { ko: '로딩 중...', es: 'Cargando...' },
    'refresh': { ko: '새로고침', es: 'Actualizar' },
    'back': { ko: '뒤로', es: 'Volver' },
    'close': { ko: '닫기', es: 'Cerrar' },
    'confirm': { ko: '확인', es: 'Confirmar' },
    'delete': { ko: '삭제', es: 'Eliminar' },
    'edit': { ko: '수정', es: 'Editar' },
    'add': { ko: '추가', es: 'Añadir' },
    'name': { ko: '이름', es: 'Nombre' },
    'email': { ko: '이메일', es: 'Correo' },
    'password': { ko: '비밀번호', es: 'Contraseña' },
    'profile': { ko: '프로필', es: 'Perfil' },
    'workspace': { ko: '워크스페이스', es: 'Espacio de trabajo' },
    'team': { ko: '팀', es: 'Equipo' },
    'member': { ko: '멤버', es: 'Miembro' },
    'members': { ko: '멤버', es: 'Miembros' },
    'invite': { ko: '초대', es: 'Invitar' },
    'invite_code': { ko: '초대 코드', es: 'Código de invitación' },
    'join': { ko: '참여', es: 'Unirse' },
    'create': { ko: '생성', es: 'Crear' },
    'status': { ko: '상태', es: 'Estado' },
    'online': { ko: '온라인', es: 'En línea' },
    'offline': { ko: '오프라인', es: 'Desconectado' },
    'active': { ko: '활성', es: 'Activo' },
    'pending': { ko: '대기', es: 'Pendiente' },

    // 3D View
    'my_view': { ko: '내 화면', es: 'Mi vista' },
    'team_view': { ko: '팀 뷰', es: 'Vista de equipo' },
    'company_view': { ko: '전사 뷰', es: 'Vista empresa' },
    'my_analysis': { ko: '내 업무 분석', es: 'Mi análisis' },
    'sessions': { ko: '세션', es: 'Sesiones' },
    'projects': { ko: '프로젝트', es: 'Proyectos' },
    'files': { ko: '파일', es: 'Archivos' },
    'events': { ko: '이벤트', es: 'Eventos' },

    // Work categories
    'work': { ko: '업무', es: 'Trabajo' },
    'personal': { ko: '개인', es: 'Personal' },
    'communication': { ko: '소통', es: 'Comunicación' },
    'document': { ko: '문서', es: 'Documento' },
    'data_entry': { ko: '데이터 입력', es: 'Entrada de datos' },
    'analysis': { ko: '분석', es: 'Análisis' },

    // Features page
    'features': { ko: '기능', es: 'Funciones' },
    'ai_tracking': { ko: 'AI 작업 추적', es: 'Seguimiento de trabajo IA' },
    'realtime_sync': { ko: '실시간 동기화', es: 'Sincronización en tiempo real' },
    'privacy': { ko: '개인정보 보호', es: 'Privacidad' },
    'terms': { ko: '이용약관', es: 'Términos de uso' },

    // Guide
    'guide': { ko: '가이드', es: 'Guía' },
    'installation': { ko: '설치', es: 'Instalación' },
    'getting_started': { ko: '시작하기', es: 'Comenzar' },

    // Settings
    'language': { ko: '언어', es: 'Idioma' },
    'theme': { ko: '테마', es: 'Tema' },
    'notifications': { ko: '알림', es: 'Notificaciones' },
    'account': { ko: '계정', es: 'Cuenta' },

    // Marketplace
    'marketplace': { ko: '마켓플레이스', es: 'Marketplace' },
    'install': { ko: '설치', es: 'Instalar' },

    // Timeline
    'timeline': { ko: '타임라인', es: 'Línea de tiempo' },
    'today': { ko: '오늘', es: 'Hoy' },
    'this_week': { ko: '이번 주', es: 'Esta semana' },
    'this_month': { ko: '이번 달', es: 'Este mes' },

    // Organization
    'organization': { ko: '조직', es: 'Organización' },
    'department': { ko: '부서', es: 'Departamento' },
    'role': { ko: '역할', es: 'Rol' },
    'manager': { ko: '관리자', es: 'Administrador' },
    'owner': { ko: '소유자', es: 'Propietario' },

    // Orbit specific
    'orbit_ai': { ko: 'Orbit AI', es: 'Orbit AI' },
    'work_universe': { ko: '작업 우주', es: 'Universo de trabajo' },
    'install_tracker': { ko: '트래커 설치', es: 'Instalar rastreador' },
    'copy_code': { ko: '설치 코드 복사', es: 'Copiar código' },
    'workspace_settings': { ko: '워크스페이스 설정', es: 'Config. espacio' },
    'invite_member': { ko: '멤버 초대', es: 'Invitar miembro' },
    'no_data': { ko: '데이터 없음', es: 'Sin datos' },
    'view_3d': { ko: '3D 뷰', es: 'Vista 3D' },
    'chat_history': { ko: '대화 이력', es: 'Historial de chat' },
    'work_analysis': { ko: '업무 분석', es: 'Análisis de trabajo' },
  };

  // Get/set language
  function getLang() { return localStorage.getItem('orbit_lang') || 'ko'; }
  function setLang(lang) { localStorage.setItem('orbit_lang', lang); translatePage(); }

  // Translate function
  function t(key) {
    const lang = getLang();
    const entry = TRANSLATIONS[key];
    if (!entry) return key;
    return entry[lang] || entry['ko'] || key;
  }

  // Translate all elements with data-i18n attribute
  function translatePage() {
    const lang = getLang();
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const entry = TRANSLATIONS[key];
      if (entry) {
        el.textContent = entry[lang] || entry['ko'];
      }
    });
    // Also translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const entry = TRANSLATIONS[key];
      if (entry) {
        el.placeholder = entry[lang] || entry['ko'];
      }
    });
    // Update toggle button
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = lang === 'ko' ? '\uD83C\uDDEA\uD83C\uDDF8 ES' : '\uD83C\uDDF0\uD83C\uDDF7 KO';
  }

  // Create toggle button
  function createToggle() {
    const btn = document.createElement('button');
    btn.id = 'lang-toggle';
    btn.textContent = getLang() === 'ko' ? '\uD83C\uDDEA\uD83C\uDDF8 ES' : '\uD83C\uDDF0\uD83C\uDDF7 KO';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;padding:6px 14px;border-radius:20px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font-size:12px;cursor:pointer;font-weight:600;transition:all .2s;';
    btn.onmouseover = function() { btn.style.borderColor = '#58a6ff'; };
    btn.onmouseout = function() { btn.style.borderColor = '#30363d'; };
    btn.onclick = function() { setLang(getLang() === 'ko' ? 'es' : 'ko'); };
    document.body.appendChild(btn);
  }

  // Export
  window.i18n = { t: t, getLang: getLang, setLang: setLang, translatePage: translatePage, TRANSLATIONS: TRANSLATIONS };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { createToggle(); translatePage(); });
  } else {
    createToggle(); translatePage();
  }
})();
