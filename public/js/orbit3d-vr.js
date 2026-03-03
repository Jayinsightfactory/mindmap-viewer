// Orbit AI — WebXR VR Button
window.OrbitVRButton = {
  createButton(renderer) {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      position:'fixed', bottom:'14px', right:'14px', zIndex:'200',
      background:'rgba(13,17,23,0.92)', border:'1px solid #21262d',
      color:'#8b949e', borderRadius:'10px', padding:'10px 18px',
      cursor:'pointer', fontSize:'13px', backdropFilter:'blur(8px)',
      transition:'all .2s', fontFamily:'inherit',
    });
    if (!navigator.xr) {
      btn.textContent = '🥽 VR 미지원'; btn.style.opacity='0.4'; btn.style.cursor='not-allowed';
      return btn;
    }
    navigator.xr.isSessionSupported('immersive-vr').then(ok => {
      if (!ok) { btn.textContent='🥽 VR 기기 없음'; btn.style.opacity='0.4'; return; }
      btn.textContent='🥽 VR 입장'; btn.style.borderColor='#58a6ff'; btn.style.color='#58a6ff';
      let sess = null;
      btn.addEventListener('click', () => {
        if (!sess) {
          navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','bounded-floor']})
            .then(s => { s.addEventListener('end',()=>{ btn.textContent='🥽 VR 입장'; sess=null; }); renderer.xr.setSession(s); btn.textContent='🥽 VR 종료'; sess=s; });
        } else { sess.end(); }
      });
    });
    return btn;
  }
};
