// Termina Interactive Simulator & Website Logic

// --- Background Worldlines Canvas Animation ---
function initBackgroundCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width, height;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const nodes = [];
  const count = 30;
  for (let i = 0; i < count; i++) {
    nodes.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: Math.random() * 2 + 1,
      color: i % 3 === 0 ? '#4fc1ff' : (i % 3 === 1 ? '#4ec9b0' : '#c586c0')
    });
  }

  function render() {
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 180) {
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `rgba(79, 193, 255, ${0.12 * (1 - dist / 180)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    nodes.forEach(n => {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > width) n.vx *= -1;
      if (n.y < 0 || n.y > height) n.vy *= -1;

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.shadowBlur = 4;
      ctx.shadowColor = n.color;
      ctx.fill();
    });

    requestAnimationFrame(render);
  }
  render();
}

// --- Monaco Editor Syntax Highlighting & Simulation Data ---
const codeFiles = {
  'src/auth.ts': [
    { num: 1, text: `<span style="color:#c586c0;">import</span> { <span style="color:#9cdcfe;">createHash</span>, <span style="color:#9cdcfe;">randomBytes</span> } <span style="color:#c586c0;">from</span> <span style="color:#ce9178;">'node:crypto'</span>;` },
    { num: 2, text: `<span style="color:#c586c0;">import</span> { <span style="color:#4ec9b0;">SessionStore</span> } <span style="color:#c586c0;">from</span> <span style="color:#ce9178;">'./session-store'</span>;` },
    { num: 3, text: `` },
    { num: 4, text: `<span style="color:#c586c0;">export</span> <span style="color:#c586c0;">interface</span> <span style="color:#4ec9b0;">AuthClaims</span> {` },
    { num: 5, text: `  <span style="color:#c586c0;">readonly</span> <span style="color:#9cdcfe;">userId</span>: <span style="color:#4ec9b0;">string</span>;` },
    { num: 6, text: `  <span style="color:#c586c0;">readonly</span> <span style="color:#9cdcfe;">role</span>: <span style="color:#ce9178;">'admin'</span> | <span style="color:#ce9178;">'contributor'</span> | <span style="color:#ce9178;">'readonly'</span>;` },
    { num: 7, text: `  <span style="color:#c586c0;">readonly</span> <span style="color:#9cdcfe;">exp</span>: <span style="color:#4ec9b0;">number</span>;` },
    { num: 8, text: `}` },
    { num: 9, text: `` },
    { num: 10, text: `<span style="color:#c586c0;">export</span> <span style="color:#c586c0;">class</span> <span style="color:#4ec9b0;">TokenValidator</span> {` },
    { num: 11, text: `  <span style="color:#c586c0;">constructor</span>(<span style="color:#c586c0;">private readonly</span> <span style="color:#9cdcfe;">sessions</span>: <span style="color:#4ec9b0;">SessionStore</span>) {}` },
    { num: 12, text: `` },
    { num: 13, text: `  <span style="color:#6a9955;">// Verified: zero-alloc hot path validation with nonce renewal</span>`, cls: 'diff-add' },
    { num: 14, text: `  <span style="color:#c586c0;">public async</span> <span style="color:#dcdcaa;">validateToken</span>(<span style="color:#9cdcfe;">header</span>: <span style="color:#4ec9b0;">string</span>): <span style="color:#4ec9b0;">Promise</span>&lt;<span style="color:#4ec9b0;">AuthClaims</span>&gt; {`, cls: 'diff-add' },
    { num: 15, text: `    <span style="color:#c586c0;">const</span> [<span style="color:#9cdcfe;">scheme</span>, <span style="color:#9cdcfe;">token</span>] = <span style="color:#9cdcfe;">header</span>.<span style="color:#dcdcaa;">split</span>(<span style="color:#ce9178;">' '</span>);`, cls: 'diff-add' },
    { num: 16, text: `    <span style="color:#c586c0;">if</span> (<span style="color:#9cdcfe;">scheme</span> !== <span style="color:#ce9178;">'Bearer'</span> || !<span style="color:#9cdcfe;">token</span>) {`, cls: 'diff-add' },
    { num: 17, text: `      <span style="color:#c586c0;">throw new</span> <span style="color:#4ec9b0;">Error</span>(<span style="color:#ce9178;">'AUTH_INVALID_SCHEME'</span>);`, cls: 'diff-add' },
    { num: 18, text: `    }`, cls: 'diff-add' },
    { num: 19, text: `    <span style="color:#c586c0;">return await</span> <span style="color:#c586c0;">this</span>.<span style="color:#9cdcfe;">sessions</span>.<span style="color:#dcdcaa;">verify</span>(<span style="color:#9cdcfe;">token</span>);`, cls: 'diff-add' },
    { num: 20, text: `  }`, cls: 'diff-add' },
    { num: 21, text: `}` }
  ],
  'src/cache.ts': [
    { num: 1, text: `<span style="color:#6a9955;">// Rust-backed zero-copy memory cache for Termina Snapshots</span>` },
    { num: 2, text: `<span style="color:#c586c0;">export</span> <span style="color:#c586c0;">class</span> <span style="color:#4ec9b0;">FastLRU</span>&lt;<span style="color:#4ec9b0;">K</span>, <span style="color:#4ec9b0;">V</span>&gt; {` },
    { num: 3, text: `  <span style="color:#c586c0;">private readonly</span> <span style="color:#9cdcfe;">store</span> = <span style="color:#c586c0;">new</span> <span style="color:#4ec9b0;">Map</span>&lt;<span style="color:#4ec9b0;">K</span>, <span style="color:#4ec9b0;">V</span>&gt;();` },
    { num: 4, text: `  <span style="color:#c586c0;">constructor</span>(<span style="color:#c586c0;">public readonly</span> <span style="color:#9cdcfe;">maxEntries</span>: <span style="color:#4ec9b0;">number</span> = <span style="color:#b5cea8;">1024</span>) {}` },
    { num: 5, text: `` },
    { num: 6, text: `  <span style="color:#dcdcaa;">get</span>(<span style="color:#9cdcfe;">key</span>: <span style="color:#4ec9b0;">K</span>): <span style="color:#4ec9b0;">V</span> | <span style="color:#4ec9b0;">undefined</span> {` },
    { num: 7, text: `    <span style="color:#c586c0;">const</span> <span style="color:#9cdcfe;">val</span> = <span style="color:#c586c0;">this</span>.<span style="color:#9cdcfe;">store</span>.<span style="color:#dcdcaa;">get</span>(<span style="color:#9cdcfe;">key</span>);` },
    { num: 8, text: `    <span style="color:#c586c0;">if</span> (<span style="color:#9cdcfe;">val</span> !== <span style="color:#4ec9b0;">undefined</span>) {` },
    { num: 9, text: `      <span style="color:#c586c0;">this</span>.<span style="color:#9cdcfe;">store</span>.<span style="color:#dcdcaa;">delete</span>(<span style="color:#9cdcfe;">key</span>);` },
    { num: 10, text: `      <span style="color:#c586c0;">this</span>.<span style="color:#9cdcfe;">store</span>.<span style="color:#dcdcaa;">set</span>(<span style="color:#9cdcfe;">key</span>, <span style="color:#9cdcfe;">val</span>);` },
    { num: 11, text: `    }` },
    { num: 12, text: `    <span style="color:#c586c0;">return</span> <span style="color:#9cdcfe;">val</span>;` },
    { num: 13, text: `  }` },
    { num: 14, text: `}` }
  ],
  'core/engine.rs': [
    { num: 1, text: `<span style="color:#c586c0;">use</span> sha2::{<span style="color:#4ec9b0;">Digest</span>, <span style="color:#4ec9b0;">Sha256</span>};` },
    { num: 2, text: `<span style="color:#c586c0;">use</span> std::path::{<span style="color:#4ec9b0;">Path</span>, <span style="color:#4ec9b0;">PathBuf</span>};` },
    { num: 3, text: `` },
    { num: 4, text: `<span style="color:#c586c0;">pub struct</span> <span style="color:#4ec9b0;">SnapshotEngine</span> {` },
    { num: 5, text: `    <span style="color:#c586c0;">pub</span> <span style="color:#9cdcfe;">store_root</span>: <span style="color:#4ec9b0;">PathBuf</span>,` },
    { num: 6, text: `    <span style="color:#c586c0;">pub</span> <span style="color:#9cdcfe;">quiet_window_ms</span>: <span style="color:#4ec9b0;">u64</span>,` },
    { num: 7, text: `}` },
    { num: 8, text: `` },
    { num: 9, text: `<span style="color:#c586c0;">impl</span> <span style="color:#4ec9b0;">SnapshotEngine</span> {` },
    { num: 10, text: `    <span style="color:#c586c0;">pub fn</span> <span style="color:#dcdcaa;">capture_working_tree</span>(&<span style="color:#9cdcfe;">self</span>, <span style="color:#9cdcfe;">root</span>: &<span style="color:#4ec9b0;">Path</span>) -&gt; <span style="color:#4ec9b0;">Result</span>&lt;<span style="color:#4ec9b0;">String</span>, <span style="color:#4ec9b0;">EngineError</span>&gt; {` },
    { num: 11, text: `        <span style="color:#6a9955;">// Byte-exact working-tree capture directly in bare app-store</span>` },
    { num: 12, text: `        <span style="color:#c586c0;">let</span> <span style="color:#9cdcfe;">hash</span> = <span style="color:#9cdcfe;">self</span>.<span style="color:#dcdcaa;">hash_tree_state</span>(<span style="color:#9cdcfe;">root</span>)?;` },
    { num: 13, text: `        <span style="color:#4ec9b0;">Ok</span>(<span style="color:#dcdcaa;">format!</span>(<span style="color:#ce9178;">"sha256:{:x}"</span>, <span style="color:#9cdcfe;">hash</span>))` },
    { num: 14, text: `    }` },
    { num: 15, text: `}` }
  ],
  'tests/auth.test.ts': [
    { num: 1, text: `<span style="color:#c586c0;">import</span> { <span style="color:#9cdcfe;">describe</span>, <span style="color:#9cdcfe;">it</span>, <span style="color:#9cdcfe;">expect</span> } <span style="color:#c586c0;">from</span> <span style="color:#ce9178;">'vitest'</span>;` },
    { num: 2, text: `<span style="color:#c586c0;">import</span> { <span style="color:#4ec9b0;">TokenValidator</span> } <span style="color:#c586c0;">from</span> <span style="color:#ce9178;">'../src/auth'</span>;` },
    { num: 3, text: `` },
    { num: 4, text: `<span style="color:#9cdcfe;">describe</span>(<span style="color:#ce9178;">'TokenValidator'</span>, () =&gt; {` },
    { num: 5, text: `  <span style="color:#9cdcfe;">it</span>(<span style="color:#ce9178;">'verifies bearer token and returns AuthClaims'</span>, <span style="color:#c586c0;">async</span> () =&gt; {` },
    { num: 6, text: `    <span style="color:#c586c0;">const</span> <span style="color:#9cdcfe;">validator</span> = <span style="color:#c586c0;">new</span> <span style="color:#4ec9b0;">TokenValidator</span>({ <span style="color:#dcdcaa;">verify</span>: <span style="color:#c586c0;">async</span> () =&gt; ({ <span style="color:#9cdcfe;">userId</span>: <span style="color:#ce9178;">'u1'</span>, <span style="color:#9cdcfe;">role</span>: <span style="color:#ce9178;">'admin'</span>, <span style="color:#9cdcfe;">exp</span>: <span style="color:#b5cea8;">9999</span> }) } <span style="color:#c586c0;">as any</span>);` },
    { num: 7, text: `    <span style="color:#c586c0;">const</span> <span style="color:#9cdcfe;">claims</span> = <span style="color:#c586c0;">await</span> <span style="color:#9cdcfe;">validator</span>.<span style="color:#dcdcaa;">validateToken</span>(<span style="color:#ce9178;">'Bearer valid-jwt-token'</span>);` },
    { num: 8, text: `    <span style="color:#9cdcfe;">expect</span>(<span style="color:#9cdcfe;">claims</span>.<span style="color:#9cdcfe;">userId</span>).<span style="color:#dcdcaa;">toBe</span>(<span style="color:#ce9178;">'u1'</span>);` },
    { num: 9, text: `  });` },
    { num: 10, text: `});` }
  ]
};

const breadcrumbMap = {
  'src/auth.ts': ['termina', 'src', 'auth.ts', 'TokenValidator', 'validateToken'],
  'src/cache.ts': ['termina', 'src', 'cache.ts', 'FastLRU', 'get'],
  'core/engine.rs': ['termina', 'core', 'engine.rs', 'SnapshotEngine', 'capture_working_tree'],
  'tests/auth.test.ts': ['termina', 'tests', 'auth.test.ts', 'TokenValidator']
};

let currentTab = 'src/auth.ts';
let terminalRunning = false;

function renderEditor(filename) {
  currentTab = filename;
  const container = document.getElementById('code-container');
  if (!container) return;

  // Sync active file tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.file === filename);
  });

  // Sync active item in modified files sidebar
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.file === filename);
  });

  // Update breadcrumbs
  const breadcrumbEl = document.getElementById('editor-breadcrumbs');
  if (breadcrumbEl && breadcrumbMap[filename]) {
    const parts = breadcrumbMap[filename];
    breadcrumbEl.innerHTML = parts.map((p, idx) => {
      const isLast = idx === parts.length - 1;
      const color = isLast ? 'var(--accent)' : (idx === parts.length - 2 ? 'var(--text)' : 'var(--text-dim)');
      return `<span style="color:${color};">${p}</span>`;
    }).join(' <span style="color:var(--text-dim);">›</span> ');
  }

  const lines = codeFiles[filename] || [];
  let html = `<div class="code-viewer">`;
  lines.forEach(l => {
    const cls = l.cls ? ` ${l.cls}` : '';
    html += `<div class="code-row${cls}">
      <span class="gutter">${l.num}</span>
      <span class="source">${l.text}</span>
    </div>`;
  });
  html += `</div>`;
  container.innerHTML = html;

  // Render Minimap
  renderMinimap(lines);
}

function renderMinimap(lines) {
  const minimap = document.getElementById('minimap-container');
  if (!minimap) return;
  let html = '';
  lines.forEach(l => {
    const isDiff = l.cls && l.cls.includes('diff');
    html += `<div class="minimap-bar${isDiff ? ' diff' : ''}"></div>`;
  });
  minimap.innerHTML = html;
}

function renderDiffReview() {
  currentTab = 'review';
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.file === 'review');
  });
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));

  const breadcrumbEl = document.getElementById('editor-breadcrumbs');
  if (breadcrumbEl) {
    breadcrumbEl.innerHTML = `<span style="color:var(--text);">Change Review</span> <span style="color:var(--text-dim);">›</span> <span style="color:var(--accent);">src/auth.ts</span>`;
  }

  const container = document.getElementById('code-container');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--bg-raised); border-bottom:1px solid var(--border); font-size:12px; font-family:var(--font-mono);">
      <span><b>Change Review</b>: <code>src/auth.ts</code> (1 added block, 0 deletions)</span>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="toast('Reverted changes'); renderEditor('src/auth.ts');">✗ Revert</button>
        <button class="btn btn-primary btn-sm" onclick="toast('✓ Accepted changes into main branch');">✓ Accept</button>
        <button class="btn btn-outline btn-sm" onclick="copyCommitSubject()">Copy Commit Subject</button>
      </div>
    </div>
    <div class="code-viewer" style="margin-top:12px;">
      <div class="code-row diff-del"><span class="gutter">14</span><span class="source">- // Legacy insecure synchronous token validator</span></div>
      <div class="code-row diff-del"><span class="gutter">15</span><span class="source">- public validateToken(h: string) { return eval(h); }</span></div>
      <div class="code-row diff-ins"><span class="gutter">14</span><span class="source">+ // Verified: zero-alloc hot path validation with nonce renewal</span></div>
      <div class="code-row diff-ins"><span class="gutter">15</span><span class="source">+ public async validateToken(header: string): Promise&lt;AuthClaims&gt; {</span></div>
      <div class="code-row diff-ins"><span class="gutter">16</span><span class="source">+   const [scheme, token] = header.split(' ');</span></div>
      <div class="code-row diff-ins"><span class="gutter">17</span><span class="source">+   if (scheme !== 'Bearer' || !token) throw new Error('AUTH_INVALID_SCHEME');</span></div>
      <div class="code-row diff-ins"><span class="gutter">18</span><span class="source">+   return await this.sessions.verify(token);</span></div>
      <div class="code-row diff-ins"><span class="gutter">19</span><span class="source">+ }</span></div>
    </div>
  `;
}

function renderPlanBoard() {
  currentTab = 'plan';
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.file === 'plan');
  });
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));

  const breadcrumbEl = document.getElementById('editor-breadcrumbs');
  if (breadcrumbEl) {
    breadcrumbEl.innerHTML = `<span style="color:var(--text);">Dispatch</span> <span style="color:var(--text-dim);">›</span> <span style="color:var(--accent);">Plan Board (2 Tasks)</span>`;
  }

  const container = document.getElementById('code-container');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <b style="font-size:13px;">Plan Board · Dispatch Parallel Workers</b>
        <span style="color:var(--green); font-size:12px; font-family:var(--font-mono);">2 / 2 Tasks Settled</span>
      </div>
      <div style="background:var(--bg-raised); border:1px solid rgba(63, 185, 80, 0.4); border-radius:var(--radius-sm); padding:12px 16px; display:flex; align-items:center; gap:12px;">
        <span style="color:var(--green); font-weight:bold; font-size:14px;">✓</span>
        <div>
          <div><b>Refactor Auth Middleware</b> (claimed: <code>src/auth.ts</code>)</div>
          <div style="color:var(--text-muted); font-size:12px;">Replaced legacy parser with zero-alloc token validator · Tests passing</div>
        </div>
        <span class="nav-pill" style="margin-left:auto; font-size:11px;">Worker #1</span>
      </div>
      <div style="background:var(--bg-raised); border:1px solid rgba(63, 185, 80, 0.4); border-radius:var(--radius-sm); padding:12px 16px; display:flex; align-items:center; gap:12px;">
        <span style="color:var(--green); font-weight:bold; font-size:14px;">✓</span>
        <div>
          <div><b>Verify &amp; Offline Evidence Contract</b> (claimed: <code>tests/auth.test.ts</code>)</div>
          <div style="color:var(--text-muted); font-size:12px;">14/14 unit tests green · 0 regression · sandbox-exec enforced</div>
        </div>
        <span class="nav-pill" style="margin-left:auto; font-size:11px;">Worker #2</span>
      </div>
    </div>
  `;
}

// --- Terminal TUI Simulation ---
const termScreen = document.getElementById('terminal-screen');

function initTerminal() {
  if (!termScreen) return;
  termScreen.innerHTML = `
<div style="color:var(--accent); font-weight:bold; margin-bottom:4px;">π pi (v0.52.1) · claude-3-5-sonnet-20241022 (thinking: high)</div>
<div style="color:var(--text-dim); margin-bottom:8px;">shift+enter for newline · /help for commands · context: 14.2k tokens</div>
<div class="term-box">
  <div class="term-box-header">┌─ Session Initialized ──────────────────────────────────────────</div>
  <div style="color:var(--text-muted);">│  Workspace: <span style="color:var(--text);">~/Desktop/proyectos/pi-editor</span></div>
  <div style="color:var(--text-muted);">│  Snapshot Store: <span style="color:var(--green);">online</span> (&lt; 4ms capture baseline)</div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────────</div>
</div>
<div style="color:var(--text-dim); margin-top:6px;">Ready for prompts. Type below or select a quick prompt.</div>
`;
}

function printTerm(text, isInput = false) {
  if (!termScreen) return;
  const div = document.createElement('div');
  div.style.marginBottom = '6px';
  if (isInput) {
    div.innerHTML = `<span style="color:var(--accent); font-weight:bold;">&gt;</span> <span style="color:#ffffff; font-weight:bold;">${escapeHtml(text)}</span>`;
  } else {
    div.innerHTML = text;
  }
  termScreen.appendChild(div);
  termScreen.scrollTop = termScreen.scrollHeight;
}

function setTerminalBusy(busy) {
  const badge = document.getElementById('term-status-text');
  if (badge) {
    badge.textContent = busy ? 'busy' : 'idle';
    badge.style.color = busy ? 'var(--yellow)' : 'var(--green)';
  }
}

async function runScenario(type) {
  if (terminalRunning) return;
  terminalRunning = true;
  setTerminalBusy(true);

  if (type === 'auth') {
    printTerm('refactor auth middleware with zero-alloc async validator and strict schema', true);
    await delay(300);
    printTerm(`<div style="color:var(--text-dim);">[pi] Analyzing codebase topology and existing imports...</div>`);
    await delay(500);
    printTerm(`
<div class="term-box">
  <div class="term-box-header">┌─ read_file: src/auth.ts ───────────────────────────────────</div>
  <div style="color:var(--text-muted);">│  21 lines read (AuthClaims, TokenValidator)</div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────</div>
</div>`);
    await delay(600);
    printTerm(`
<div class="term-box">
  <div class="term-box-header">┌─ write_to_file: src/auth.ts ───────────────────────────────</div>
  <div style="color:var(--green);">│  + 14 lines added, - 3 lines deleted</div>
  <div style="color:var(--text-muted);">│  ✓ Added AuthClaims interface &amp; async token verification</div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────</div>
</div>
<div style="color:var(--accent); font-size:11.5px;">✓ file written · live sync auto-opened in Monaco IDE</div>`);
    
    // Auto open tab in Monaco Editor
    renderEditor('src/auth.ts');
    toast('Live Sync: Monaco auto-opened src/auth.ts');
    
    await delay(600);
    printTerm(`
<div class="term-box">
  <div class="term-box-header">┌─ bash: npm test ───────────────────────────────────────────</div>
  <div style="color:var(--green);">│  PASS tests/auth.test.ts (14/14 tests passed, 18ms)</div>
  <div style="color:var(--text-muted);">│  Hot path allocs: 0 bytes · Zero regression</div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────</div>
</div>
<div style="color:var(--green); font-weight:bold; font-size:12px;">✓ Verified: 14/14 tests green · Snapshot Checkpoint #4 ready</div>`);
    await delay(350);
    updateTimeline(3);
  } else if (type === 'challenge') {
    printTerm('/challenge performance-first', true);
    await delay(350);
    printTerm(`
<div class="term-box">
  <div class="term-box-header">┌─ Worldlines Challenge Mode ───────────────────────────────</div>
  <div style="color:var(--text-muted);">│  Candidate A: <span style="color:var(--text);">Reference Settled Run</span></div>
  <div style="color:var(--purple);">│  Candidate B: <span style="color:#ffffff;">Alternative Challenger (performance-first)</span></div>
  <div style="color:var(--text-muted);">│  Sandboxes: <span style="color:var(--accent);">APFS Copy-on-Write Materialized (28ms)</span></div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────</div>
</div>`);
    await delay(700);
    printTerm(`<div style="color:var(--green); font-weight:bold;">★ Candidate B ranked Evidence Winner (-44% latency, zero deps)</div>`);
    toast('Worldlines Challenge Mode: Candidate B ranked Winner');
    
    const el = document.getElementById('worldlines');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else if (type === 'models') {
    printTerm('/models', true);
    await delay(250);
    printTerm(`
<div class="term-box">
  <div class="term-box-header">┌─ Pi Configured Models &amp; Providers ────────────────────────</div>
  <div style="color:var(--green);">│  1. claude-3-5-sonnet-20241022 (Anthropic) [active]</div>
  <div style="color:var(--text-muted);">│  2. gemini-2.5-pro (Google AI Studio / Vertex)</div>
  <div style="color:var(--text-muted);">│  3. gpt-4o (OpenAI API)</div>
  <div style="color:var(--text-muted);">│  4. llama-3.3-70b (Ollama local / offline)</div>
  <div class="term-box-header">└───────────────────────────────────────────────────────────</div>
</div>`);
  }

  setTerminalBusy(false);
  terminalRunning = false;
}

function updateTimeline(activeIdx) {
  document.querySelectorAll('.dot-event').forEach((dot, idx) => {
    dot.classList.toggle('active', idx === activeIdx);
  });
}

function handleTerminalInput(e) {
  if (e.key === 'Enter') {
    const input = document.getElementById('term-input');
    const val = input.value.trim();
    if (!val) return;
    input.value = '';
    if (val.startsWith('/models')) {
      runScenario('models');
    } else if (val.toLowerCase().includes('challenge')) {
      runScenario('challenge');
    } else {
      runScenario('auth');
    }
  }
}

// --- Worldlines Challenge Mode Profiles ---
const challengeData = {
  'performance': {
    title: '⚡ Performance-First Profile',
    desc: 'Minimizes hot-path execution latency, memory footprint, and allocation overhead.',
    candA: { lat: '34ms', mem: '14.2MB', pass: '100%', deps: '+1', loc: '+42' },
    candB: { lat: '19ms', mem: '8.1MB', pass: '100%', deps: '0', loc: '+18' },
    winner: 'B',
    reason: 'Candidate B delivers 44% lower latency with zero dynamic heap allocations in hot path.'
  },
  'deps': {
    title: '📦 Fewer Dependencies Profile',
    desc: 'Prefers native standard library primitives over external npm packages.',
    candA: { lat: '34ms', mem: '14.2MB', pass: '100%', deps: '+2 (lodash, axios)', loc: '+12' },
    candB: { lat: '35ms', mem: '12.0MB', pass: '100%', deps: '0 (native fetch & crypto)', loc: '+28' },
    winner: 'B',
    reason: 'Candidate B achieves 100% test parity with zero new dependencies.'
  },
  'preserve-api': {
    title: '🔒 Preserve API Profile',
    desc: 'Guarantees zero breaking changes on exported public TypeScript interfaces.',
    candA: { lat: '34ms', mem: '14.2MB', pass: '100%', deps: '0', loc: '+15' },
    candB: { lat: '33ms', mem: '14.1MB', pass: '100%', deps: '0', loc: '+14' },
    winner: 'A',
    reason: 'Candidate A strictly preserves all existing optional parameter signatures.'
  },
  'simpler': {
    title: '🧼 Simpler Implementation Profile',
    desc: 'Lowest conceptual complexity, ASD-STE100 compliance, fewest lines of code.',
    candA: { lat: '34ms', mem: '14.2MB', pass: '100%', deps: '0', loc: '+65' },
    candB: { lat: '32ms', mem: '11.8MB', pass: '100%', deps: '0', loc: '+19' },
    winner: 'B',
    reason: 'Candidate B has 70% fewer lines and single canonical responsibility ownership.'
  }
};

function selectChallenge(profileKey) {
  document.querySelectorAll('.profile-card').forEach(c => {
    c.classList.toggle('active', c.dataset.profile === profileKey);
  });

  const data = challengeData[profileKey];
  if (!data) return;

  const titleEl = document.getElementById('profile-title');
  const descEl = document.getElementById('profile-desc');
  if (titleEl) titleEl.innerText = data.title;
  if (descEl) descEl.innerText = data.desc;

  // Update candidate A stats
  const aLat = document.getElementById('candA-lat');
  const aMem = document.getElementById('candA-mem');
  const aPass = document.getElementById('candA-pass');
  const aDeps = document.getElementById('candA-deps');
  const aLoc = document.getElementById('candA-loc');
  if (aLat) aLat.innerText = data.candA.lat;
  if (aMem) aMem.innerText = data.candA.mem;
  if (aPass) aPass.innerText = data.candA.pass;
  if (aDeps) aDeps.innerText = data.candA.deps;
  if (aLoc) aLoc.innerText = data.candA.loc;

  // Update candidate B stats
  const bLat = document.getElementById('candB-lat');
  const bMem = document.getElementById('candB-mem');
  const bPass = document.getElementById('candB-pass');
  const bDeps = document.getElementById('candB-deps');
  const bLoc = document.getElementById('candB-loc');
  if (bLat) bLat.innerText = data.candB.lat;
  if (bMem) bMem.innerText = data.candB.mem;
  if (bPass) bPass.innerText = data.candB.pass;
  if (bDeps) bDeps.innerText = data.candB.deps;
  if (bLoc) bLoc.innerText = data.candB.loc;

  // Highlight winner box
  const cardA = document.getElementById('candA-card');
  const cardB = document.getElementById('candB-card');
  if (cardA && cardB) {
    cardA.classList.toggle('winner-highlight', data.winner === 'A');
    cardB.classList.toggle('winner-highlight', data.winner === 'B');
  }

  // Update winner badge text
  const reasonEl = document.getElementById('winner-reason-text');
  if (reasonEl) {
    reasonEl.innerText = `Candidate ${data.winner} Selected: ${data.reason}`;
  }
}

// --- Theme and Layout Switching ---
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('termina_theme', theme);
  toast(`Switched theme to "${theme}"`);
}

function setLayout(layoutClass) {
  const ws = document.querySelector('.cockpit-workspace');
  if (!ws) return;
  ws.classList.remove('layout-reverse', 'layout-vertical');
  if (layoutClass) ws.classList.add(layoutClass);
  toast('Updated cockpit workspace layout');
}

// --- Install Tab Switching ---
function setInstallTab(tabId) {
  document.querySelectorAll('.install-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  document.querySelectorAll('.install-pane').forEach(p => {
    p.style.display = p.id === `install-${tabId}` ? 'block' : 'none';
  });
}

function copyText(str) {
  navigator.clipboard.writeText(str).then(() => {
    toast(`Copied to clipboard: ${str}`);
  });
}

function copyCommitSubject() {
  const msg = 'feat(auth): add zero-alloc token validator with strict schema check';
  navigator.clipboard.writeText(msg).then(() => {
    toast(`Copied commit subject: "${msg}"`);
  });
}

// --- Toast notification utility ---
function toast(msg) {
  const existing = document.querySelector('.toast-notice');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'toast-notice';
  el.innerText = msg;
  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Page Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initBackgroundCanvas();
  initTerminal();
  renderEditor('src/auth.ts');

  // Load saved theme
  const savedTheme = localStorage.getItem('termina_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) themeSelect.value = savedTheme;

  // Add click listeners to timeline dots
  document.querySelectorAll('.dot-event').forEach((dot, idx) => {
    dot.addEventListener('click', () => {
      updateTimeline(idx);
      toast(`Inspecting snapshot checkpoint #${idx + 1}`);
    });
  });
});
