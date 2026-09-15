// 공통 상단 메뉴 — 페이지마다 제각각 손으로 적던 링크 목록을 이 파일 한 곳에서 관리한다.
// 사용: 링크를 넣을 컨테이너에 data-site-nav 속성 + <script src="/js/site-nav.js"></script>
// 컨테이너의 기존 CSS(a 태그 스타일)를 그대로 쓰도록 <a>만 채운다. 현재 페이지는 목록에서 뺀다.
(function () {
  var MENU = [
    ['/my-work.html', '내 작업 데이터'],
    ['/admin-analysis.html', '분석'],
    ['/nenova-dashboard.html', '전산'],
    ['/automation-flow.html', '자동화'],
    ['/orbit-hub.html', 'Company OS'],
    ['/orbit-os.html', 'MOYI OS'],
    ['/dashboard.html', '대시보드'],
    ['/orbit3d.html', '3D뷰'],
  ];
  function render() {
    var here = location.pathname;
    document.querySelectorAll('[data-site-nav]').forEach(function (el) {
      el.innerHTML = MENU
        .filter(function (m) { return m[0] !== here; })
        .map(function (m) { return '<a href="' + m[0] + '">' + m[1] + '</a>'; })
        .join('');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
