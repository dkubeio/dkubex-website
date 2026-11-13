// Static-demo shim, loaded just before the real launcher's app.js.
//
// app.js is copied unchanged from launcher/. It talks to the workspace over three
// fetches — apps.json, _control/status, _control/stop — and none of them exist on a
// static site (or when index.html is double-clicked). This answers them from the
// sample data build.py writes into window.DEMO_APPS, so app.js runs as-is.
(function () {
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  function json(body) {
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
    );
  }

  // Apps the visitor has opened show the green "running" dot, as they would live.
  function runningStates() {
    var states = {};
    try {
      var opened = JSON.parse(localStorage.getItem("workspace:openedApps") || "[]");
      opened.forEach(function (n) { states[n] = "RUNNING"; });
    } catch (e) {}
    return states;
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("apps.json") === 0) return json(window.DEMO_APPS);
    if (url.indexOf("_control/status") === 0) return json({ states: runningStates() });
    if (url.indexOf("_control/stop") === 0) return json({ ok: true });
    return realFetch ? realFetch(input, init) : Promise.reject(new Error("no fetch"));
  };

  // A small, dismissable note so nobody mistakes the demo for a live workspace.
  document.addEventListener("DOMContentLoaded", function () {
    var note = document.createElement("div");
    note.className = "demo-note";
    note.innerHTML =
      "<span><strong>Demo</strong> · sample data, nothing is running</span>" +
      '<button type="button" aria-label="Hide demo note">×</button>';
    note.querySelector("button").addEventListener("click", function () { note.remove(); });
    document.body.appendChild(note);
  });
})();
