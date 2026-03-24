// i18n.js — Orbit AI 다국어 지원 (한국어 ↔ 스페인어)
// HTML 수정 없이 페이지 내 한국어 텍스트를 자동으로 찾아서 번역
(function() {
  // 한국어 → 스페인어 매핑 (정확한 문자열 매칭)
  const KO_ES = {
    // 공통 UI
    '대시보드': 'Panel',
    '설정': 'Configuración',
    '로그인': 'Iniciar sesión',
    '로그아웃': 'Cerrar sesión',
    '저장': 'Guardar',
    '취소': 'Cancelar',
    '검색': 'Buscar',
    '검색...': 'Buscar...',
    '로딩 중...': 'Cargando...',
    '로딩...': 'Cargando...',
    '새로고침': 'Actualizar',
    '뒤로': 'Volver',
    '닫기': 'Cerrar',
    '확인': 'Confirmar',
    '삭제': 'Eliminar',
    '수정': 'Editar',
    '추가': 'Añadir',
    '이름': 'Nombre',
    '이메일': 'Correo',
    '비밀번호': 'Contraseña',
    '프로필': 'Perfil',
    '계정': 'Cuenta',
    '알림': 'Notificaciones',
    '언어': 'Idioma',
    '테마': 'Tema',
    '전체': 'Todo',
    '없음': 'Ninguno',

    // 네비게이션
    '내 화면': 'Mi vista',
    '팀 뷰': 'Vista equipo',
    '전사 뷰': 'Vista empresa',
    '내 업무 분석': 'Mi análisis',
    '3D 뷰로 돌아가기': 'Volver a vista 3D',
    '← 대시보드': '← Panel',
    '← 대시보드로 돌아가기': '← Volver al panel',

    // 워크스페이스
    '워크스페이스': 'Espacio de trabajo',
    '워크스페이스 설정': 'Config. espacio',
    '팀': 'Equipo',
    '멤버': 'Miembro',
    '멤버 초대': 'Invitar miembro',
    '초대': 'Invitar',
    '초대 코드': 'Código de invitación',
    '초대코드': 'Código',
    '참여': 'Unirse',
    '생성': 'Crear',
    '관리자': 'Administrador',
    '소유자': 'Propietario',

    // 상태
    '상태': 'Estado',
    '온라인': 'En línea',
    '오프라인': 'Desconectado',
    '활성': 'Activo',
    '대기': 'Pendiente',
    '대기 중': 'En espera',

    // 업무 카테고리
    '업무': 'Trabajo',
    '개인': 'Personal',
    '소통': 'Comunicación',
    '문서': 'Documento',
    '분석': 'Análisis',

    // 3D 뷰
    '세션': 'Sesiones',
    '프로젝트': 'Proyectos',
    '파일': 'Archivos',
    '이벤트': 'Eventos',
    '작업 우주': 'Universo de trabajo',

    // 페이지 제목
    '기능': 'Funciones',
    '가이드': 'Guía',
    '시작하기': 'Comenzar',
    '설치': 'Instalar',
    '마켓플레이스': 'Marketplace',
    '개인정보 보호': 'Privacidad',
    '이용약관': 'Términos',
    '타임라인': 'Línea de tiempo',
    '조직': 'Organización',
    '부서': 'Departamento',
    '역할': 'Rol',
    '대화 이력': 'Historial de chat',
    '작업 내역': 'Historial de trabajo',

    // 날짜
    '오늘': 'Hoy',
    '이번 주': 'Esta semana',
    '이번 달': 'Este mes',

    // Orbit 고유
    '트래커 설치': 'Instalar rastreador',
    '설치 코드 복사': 'Copiar código',
    '데이터 없음': 'Sin datos',

    // 에러
    '서버 연결 실패': 'Error de conexión',
    '데이터 로드 실패': 'Error al cargar datos',
    '오류': 'Error',
    '실패': 'Error',
    '성공': 'Éxito',

    // 분석
    '업무 분석 대시보드': 'Panel de análisis',
    '분석 결과': 'Resultados',
    '요약': 'Resumen',
    '상세': 'Detalle',
    '리포트': 'Informe',

    // 기타
    'Claude 오프라인': 'Claude sin conexión',
    'Claude 온라인': 'Claude en línea',
    'Google로 계속하기': 'Continuar con Google',
    'GitHub로 계속하기': 'Continuar con GitHub',
    '회원가입': 'Registrarse',
    '로그인하면 작업 데이터가 자동으로 저장됩니다': 'Al iniciar sesión, los datos se guardan automáticamente',
    '또는': 'o',
    '이 없으신가요?': '¿No tienes?',
    '계속하기': 'Continuar',
    '게스트': 'Invitado',
    '뷰 모드': 'Modo vista',
    '간격 조절': 'Ajustar espacio',
    '전사': 'Empresa',
    '워크스페이스가 없습니다': 'No hay espacio de trabajo',
    '먼저 워크스페이스를 생성하세요': 'Crea un espacio primero',
    '데이터를 불러오는 중': 'Cargando datos',
    '분석 중': 'Analizando',
    '실행 중': 'Ejecutando',
    '테스트 중': 'Probando',
    '처리 중': 'Procesando',
    '복사': 'Copiar',
    '붙여넣기': 'Pegar',
    '다운로드': 'Descargar',
    '업로드': 'Subir',
    '전송': 'Enviar',
    '완료': 'Completado',
    '진행 중': 'En progreso',
    '준비 중': 'Preparando',
  };

  // 역방향 매핑 생성 (스페인어 → 한국어)
  const ES_KO = {};
  for (const [ko, es] of Object.entries(KO_ES)) {
    ES_KO[es] = ko;
  }

  function getLang() { return localStorage.getItem('orbit_lang') || 'ko'; }

  function setLang(lang) {
    const prev = getLang();
    localStorage.setItem('orbit_lang', lang);
    if (prev !== lang) translatePage(prev, lang);
    updateButton();
  }

  // 페이지 내 모든 텍스트 노드를 순회하며 번역
  function translatePage(fromLang, toLang) {
    const map = toLang === 'es' ? KO_ES : ES_KO;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      let text = node.textContent;
      if (!text || !text.trim()) continue;

      let changed = false;
      for (const [from, to] of Object.entries(map)) {
        if (text.includes(from)) {
          text = text.split(from).join(to);
          changed = true;
        }
      }
      if (changed) node.textContent = text;
    }

    // placeholder, title, aria-label도 번역
    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(el => {
      let ph = el.placeholder;
      for (const [from, to] of Object.entries(map)) {
        if (ph.includes(from)) ph = ph.split(from).join(to);
      }
      el.placeholder = ph;
    });

    document.querySelectorAll('[title]').forEach(el => {
      let t = el.title;
      for (const [from, to] of Object.entries(map)) {
        if (t.includes(from)) t = t.split(from).join(to);
      }
      el.title = t;
    });
  }

  function updateButton() {
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = getLang() === 'ko' ? '🇪🇸 ES' : '🇰🇷 KO';
  }

  function createToggle() {
    if (document.getElementById('lang-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'lang-toggle';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;padding:6px 14px;border-radius:20px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font-size:12px;cursor:pointer;font-weight:600;transition:all .2s;';
    btn.onmouseover = () => btn.style.borderColor = '#58a6ff';
    btn.onmouseout = () => btn.style.borderColor = '#30363d';
    btn.onclick = () => setLang(getLang() === 'ko' ? 'es' : 'ko');
    document.body.appendChild(btn);
    updateButton();
  }

  // t() 함수 — 프로그래밍용
  function t(key) {
    if (getLang() === 'es') return KO_ES[key] || key;
    return key;
  }

  window.i18n = { t, getLang, setLang, translatePage: () => {
    const lang = getLang();
    if (lang === 'es') translatePage('ko', 'es');
  }, KO_ES, ES_KO };

  // 초기화
  function init() {
    createToggle();
    if (getLang() === 'es') translatePage('ko', 'es');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 동적 콘텐츠 대응 — 1초마다 새 텍스트 번역 (가벼움)
  if (getLang() === 'es') {
    setInterval(() => {
      if (getLang() === 'es') translatePage('ko', 'es');
    }, 3000);
  }
})();
