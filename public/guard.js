/* Safety net: runs before the app. If the app fails to start (old cached files, unsupported browser, script error)
   the user sees a clear message and a Reload button instead of a blank screen. */
(function () {
  var shown = false;
  function appStarted() { var a = document.getElementById('app'); return !!a && !a.querySelector('.boot') && a.children.length > 0; }
  function show(reason) {
    if (shown || appStarted()) return; shown = true;
    var a = document.getElementById('app'); if (!a) return;
    a.textContent = '';
    var box = document.createElement('div'); box.className = 'fatal';
    var h = document.createElement('h2'); h.textContent = 'The monitor could not start';
    var p = document.createElement('p'); p.textContent = 'This is usually caused by an out-of-date copy of the page saved in your browser. Press Reload; if it still fails, press Cmd+Shift+R (Ctrl+Shift+R on Windows) to do a full refresh.';
    var d = document.createElement('pre'); d.textContent = 'Details: ' + String(reason || 'unknown error').slice(0, 400) + '\nBrowser: ' + navigator.userAgent;
    var b = document.createElement('button'); b.className = 'btn pri'; b.textContent = 'Reload'; b.onclick = function () { location.reload(); };
    box.appendChild(h); box.appendChild(p); box.appendChild(d); box.appendChild(b); a.appendChild(box);
  }
  window.addEventListener('error', function (e) { if (!appStarted()) show(e.message || (e.target && e.target.src ? 'failed to load ' + e.target.src : 'script error')); }, true);
  window.addEventListener('unhandledrejection', function (e) { if (!appStarted()) show(e.reason && (e.reason.message || e.reason)); });
  setTimeout(function () { if (!appStarted()) show('the app did not finish starting within 8 seconds'); }, 8000);
  window.__tgtGuardShow = show;
})();
