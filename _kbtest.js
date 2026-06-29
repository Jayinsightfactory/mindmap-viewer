const kb = require('./src/keyboard-watcher');
const ms = require('./src/mouse-watcher');

if (typeof kb.subscribeInput !== 'function') throw new Error('kb.subscribeInput 누락');

let registered = null;
const fakeSubscribe = (handlers, name) => { registered = { handlers, name }; return () => { registered = null; }; };
ms.start({ getActiveApp: () => 'test', getActiveWindow: () => 'win', subscribeInput: fakeSubscribe });
if (!registered) throw new Error('mouse-watcher가 구독 안 함');
if (registered.name !== 'mouse-watcher') throw new Error('구독 name 불일치: ' + registered.name);
for (const k of ['onMousedown','onMouseup','onMousemove','onWheel']) {
  if (typeof registered.handlers[k] !== 'function') throw new Error('핸들러 누락: ' + k);
}
registered.handlers.onMousedown({ x: 100, y: 200, button: 1 });
registered.handlers.onMousemove({ x: 150, y: 250 });
registered.handlers.onWheel({ rotation: 1 });
registered.handlers.onMouseup({ x: 150, y: 250, button: 1 });

const unsub = kb.subscribeInput({ onMousedown: () => {} }, 'test-sub');
if (typeof unsub !== 'function') throw new Error('unsubscribe 반환 안 함');
unsub();

ms.stop();
if (registered !== null) throw new Error('stop 후에도 구독 남음');

console.log('ALL WIRING TESTS PASSED');
