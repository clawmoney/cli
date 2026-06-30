// Companion preload — runs before the desktop UI's own scripts. With
// contextIsolation:false it shares the page world, so it can patch globals.
//
// The desktop UI's mock mode starts a 5.2s "balance ticker"
// (window.setInterval(fn, 5200)) that does a full innerHTML rebuild every tick
// -> flickers the transparent window. We skip ONLY that timer. Everything else
// — including the mock async setTimeout(80) the boot sequence awaits — runs
// untouched (clearing all timers is what previously hung the boot screen).
const _setInterval = window.setInterval.bind(window);
window.setInterval = function (handler, timeout, ...args) {
  if (timeout === 5200) return 0;
  return _setInterval(handler, timeout, ...args);
};
