/**
 * Orbit Theme Engine
 * ────────────────────────────────────────────────────────────────
 * Manages theme switching, persistence, and saber color variants.
 *
 * Usage:
 *   OrbitTheme.set('starwars');
 *   OrbitTheme.setSaber('red');
 *   OrbitTheme.toggle();  // cycles through themes
 */
const OrbitTheme = (() => {
  const STORAGE_KEY  = 'orbit-theme';
  const SABER_KEY    = 'orbit-saber';
  const THEMES       = ['default', 'starwars'];
  const SABERS       = ['blue', 'red', 'green', 'purple', 'white'];
  const SABER_LABELS = {
    blue:   'Jedi Blue',
    red:    'Sith Red',
    green:  'Yoda Green',
    purple: 'Mace Windu',
    white:  'Ahsoka White',
  };

  let _current = 'default';
  let _saber   = 'blue';

  function _apply() {
    document.documentElement.setAttribute('data-theme', _current);
    if (_current === 'starwars') {
      document.documentElement.setAttribute('data-saber', _saber);
    } else {
      document.documentElement.removeAttribute('data-saber');
    }
    try {
      localStorage.setItem(STORAGE_KEY, _current);
      localStorage.setItem(SABER_KEY, _saber);
    } catch (_) { /* private browsing */ }

    document.dispatchEvent(new CustomEvent('orbit-theme-change', {
      detail: { theme: _current, saber: _saber }
    }));
  }

  function init() {
    try {
      _current = localStorage.getItem(STORAGE_KEY) || 'default';
      _saber   = localStorage.getItem(SABER_KEY)   || 'blue';
    } catch (_) {}
    if (!THEMES.includes(_current)) _current = 'default';
    if (!SABERS.includes(_saber))   _saber   = 'blue';
    _apply();
  }

  function set(theme) {
    if (THEMES.includes(theme)) {
      _current = theme;
      _apply();
    }
  }

  function get() { return _current; }

  function toggle() {
    const idx = THEMES.indexOf(_current);
    _current = THEMES[(idx + 1) % THEMES.length];
    _apply();
    return _current;
  }

  function setSaber(color) {
    if (SABERS.includes(color)) {
      _saber = color;
      _apply();
    }
  }

  function getSaber() { return _saber; }

  function cycleSaber() {
    const idx = SABERS.indexOf(_saber);
    _saber = SABERS[(idx + 1) % SABERS.length];
    _apply();
    return { saber: _saber, label: SABER_LABELS[_saber] };
  }

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    init, set, get, toggle,
    setSaber, getSaber, cycleSaber,
    THEMES, SABERS, SABER_LABELS,
  };
})();
