/* Termina landing — interactions
   One scenario loops in the cockpit mockup: the TUI types,
   the editor fills with diffs, the timeline lights up. */

(() => {
  "use strict";

  /* ---------- ticker: duplicate content for seamless loop ---------- */
  const track = document.getElementById("ticker-track");
  if (track) track.innerHTML += track.innerHTML;

  /* ---------- scroll reveals ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        if (e.target.id === "wl-svg") drawWorldline();
        if (e.target.id === "bench-chart") growBars();
        io.unobserve(e.target);
      }
    },
    { threshold: 0.25 }
  );
  document.querySelectorAll(".reveal, #wl-svg").forEach((el) => io.observe(el));

  /* ---------- benchmark bars ---------- */
  function growBars() {
    document.querySelectorAll("#bench-chart .bar").forEach((bar, i) => {
      setTimeout(() => { bar.style.width = bar.dataset.w + "%"; }, i * 90);
    });
  }

  /* ---------- worldline diagram draw-on-scroll ---------- */
  function drawWorldline() {
    const paths = ["wl-trunk", "wl-trunk2", "wl-a", "wl-b"];
    paths.forEach((id, i) => {
      const p = document.getElementById(id);
      if (!p) return;
      setTimeout(() => p.classList.add("drawn"), 150 + i * 450);
    });
    // merge + arrow last
    ["wl-merge", "wl-merge-arrow"].forEach((id, i) => {
      const p = document.getElementById(id);
      if (!p) return;
      setTimeout(() => p.classList.add("drawn"), 2300 + i * 300);
    });
    // nodes fade in progressively
    const nodes = document.querySelectorAll("#wl-svg .wl-node");
    nodes.forEach((n, i) => {
      setTimeout(() => n.classList.add("on"), 400 + i * 260);
    });
  }

  /* ============================================================
     Cockpit mockup simulation
     ============================================================ */

  const tuiScreen = document.getElementById("tui-screen");

  const TUI_SCRIPT = [
    { cls: "dim", text: "$ pi" },
    { cls: "dim", text: "✳ session ready — gemini-2.5-pro · plan mode off" },
    { cls: "user", text: "add token caching to the auth middleware", type: true },
    { cls: "agent", text: "Reading the middleware and auth module first…", pauseAfter: 900 },
    { cls: "tool", text: "⚙ read_file  src/middleware.ts (84 lines)", pauseAfter: 700 },
    { cls: "tool", text: "⚙ read_file  src/auth/tokens.ts (51 lines)", pauseAfter: 900 },
    { cls: "agent", text: "Adding an LRU cache around token verification.", pauseAfter: 700 },
    { cls: "tool", text: "✎ write_file  src/auth/cache.ts", edit: "cache" },
    { cls: "tool", text: "✎ write_file  src/middleware.ts", edit: "mw" },
    { cls: "tool", text: "✎ write_file  tests/cache.test.ts", edit: "test" },
    { cls: "agent", text: "Running verify against the test suite…" },
    { cls: "ok", text: "✓ verify — 12/12 passed · offline sandbox · 2.1s" },
    { cls: "agent", text: "Done. Review the diff on the right →" },
  ];

  const CODE = {
    cache: {
      file: "cache",
      lines: [
        '<span class="cm">// fresh in this run — written by the agent</span>',
        '<span class="kw">import</span> { <span class="ty">LRUCache</span> } <span class="kw">from</span> <span class="str">"./lru"</span>;',
        "",
        '<span class="kw">const</span> cache = <span class="kw">new</span> <span class="ty">LRUCache</span>&lt;<span class="ty">string</span>, <span class="ty">Token</span>&gt;(<span class="fn">256</span>);',
        "",
        '<span class="kw">export function</span> <span class="fn">verifyCached</span>(raw: <span class="ty">string</span>) {',
        '  <span class="kw">const</span> hit = cache.<span class="fn">get</span>(raw);',
        '  <span class="kw">if</span> (hit) <span class="kw">return</span> hit;',
        '  <span class="kw">const</span> token = <span class="fn">verify</span>(raw);',
        '  cache.<span class="fn">set</span>(raw, token);',
        "  <span class=\"kw\">return</span> token;",
        "}",
      ],
    },
    mw: {
      file: "mw",
      lines: [
        '<span class="cm">// middleware.ts — two changed lines</span>',
        '<span class="kw">import</span> { <span class="fn">verifyCached</span> } <span class="kw">from</span> <span class="str">"./auth/cache"</span>;',
        "",
        '<span class="kw">export async function</span> <span class="fn">auth</span>(req, res, next) {',
        '- <span class="kw">const</span> token = <span class="fn">verify</span>(req.headers.authorization);',
        '+ <span class="kw">const</span> token = <span class="fn">verifyCached</span>(req.headers.authorization);',
        "  req.user = token.subject;",
        "  <span class=\"fn\">next</span>();",
        "}",
      ],
    },
    test: {
      file: "test",
      lines: [
        '<span class="cm">// new file — the agent wrote its own tests</span>',
        '<span class="fn">it</span>(<span class="str">"caches repeated tokens"</span>, () =&gt; {',
        '  <span class="fn">verifyCached</span>(raw);',
        '  <span class="fn">expect</span>(spies.verify).<span class="fn">toHaveBeenCalledTimes</span>(<span class="fn">1</span>);',
        '  <span class="fn">verifyCached</span>(raw);',
        '  <span class="fn">expect</span>(spies.verify).<span class="fn">toHaveBeenCalledTimes</span>(<span class="fn">1</span>);',
        "});",
      ],
    },
  };

  let lineIndex = 0;

  function addTuiLine(entry) {
    const div = document.createElement("div");
    div.className = "tui-line " + entry.cls;
    tuiScreen.appendChild(div);

    if (entry.type) {
      // typewriter effect for user prompt
      let i = 0;
      const timer = setInterval(() => {
        div.textContent = entry.text.slice(0, ++i);
        if (i >= entry.text.length) clearInterval(timer);
      }, 34);
      return 40 * entry.text.length + 500;
    }
    div.textContent = entry.text;
    return 0;
  }

  function showCode(key) {
    const spec = CODE[key];
    if (!spec) return;
    // activate tab
    document.querySelectorAll(".ed-file").forEach((f) => f.classList.remove("active"));
    document.getElementById("tab-" + spec.file).classList.add("active");

    const area = document.getElementById("code-area");
    area.innerHTML = "";
    spec.lines.forEach((html, idx) => {
      const row = document.createElement("div");
      row.className = "code-line" + (html.startsWith("-") ? " del" : html.startsWith("+") ? " add" : "");
      row.innerHTML = html || "&nbsp;";
      area.appendChild(row);
      setTimeout(() => row.classList.add("on"), 90 * idx + 60);
    });
  }

  function lightTimeline(upTo) {
    const dots = document.querySelectorAll(".tl-dot");
    const total = dots.length;
    dots.forEach((d, i) => {
      if (i < upTo) d.classList.add("lit");
      else d.classList.remove("lit");
    });
    const fill = document.getElementById("tl-fill");
    const pct = Math.max(0, ((upTo - 1) / (total - 1)) * 100 - 2);
    fill.style.width = pct + "%";
  }

  function resetMockup() {
    tuiScreen.innerHTML = "";
    lineIndex = 0;
    lightTimeline(0);
  }

  function playScenario() {
    resetMockup();
    const stepDurations = [];

    function next() {
      if (lineIndex >= TUI_SCRIPT.length) {
        // hold the finished state, then restart
        setTimeout(playScenario, 6500);
        return;
      }
      const entry = TUI_SCRIPT[lineIndex++];
      let wait = 620;
      if (entry.edit) {
        showCode(entry.edit);
        wait = 1100;
      }
      const typeTime = addTuiLine(entry);
      if (entry.pauseAfter) wait = Math.max(wait, entry.pauseAfter);
      // trim old TUI lines so the pane never scrolls awkwardly
      while (tuiScreen.children.length > 11) tuiScreen.removeChild(tuiScreen.firstChild);

      // timeline progress heuristic
      const progressEvents = [3, 4, 8, 9, 11];
      const stepNo = progressEvents.indexOf(lineIndex);
      if (stepNo !== -1) lightTimeline(stepNo + 1);

      setTimeout(next, wait + typeTime);
    }
    next();
  }

  // start when the mockup scrolls into view; replay on re-entry is avoided
  const mockup = document.querySelector(".mockup");
  if (mockup) {
    const mio = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          mio.disconnect();
          setTimeout(playScenario, 600);
        }
      },
      { threshold: 0.3 }
    );
    mio.observe(mockup);
  }

  /* ---------- install tabs ---------- */
  document.querySelectorAll(".install-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".install-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".install-pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.install-pane[data-pane="${tab.dataset.tab}"]`).classList.add("active");
    });
  });

  /* ---------- copy buttons ---------- */
  function flash(btn) {
    const prev = btn.textContent;
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = prev; }, 1400);
  }

  document.querySelectorAll(".copy-cmd").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.cmd);
      } catch {}
      flash(btn);
    });
  });
})();
