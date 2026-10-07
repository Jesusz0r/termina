/* A presentation-only study. It never calls Electron, a provider, or a filesystem. */
(() => {
  const projects = [
    { id: "termina", name: "termina", initial: "T", path: "~/projects/termina", context: "Desktop editor" },
    { id: "storefront", name: "storefront", initial: "S", path: "~/projects/storefront", context: "Customer experience" },
    { id: "platform", name: "platform-api", initial: "P", path: "~/projects/platform-api", context: "Services & contracts" },
  ];
  const sampleTasks = [
    { id: "tabs", project: "termina", title: "Keep project context on switch", status: "working", description: "Testing editor and terminal restoration.", agent: "Agent 01", area: "Separate · context-switch", elapsed: "4m 12s", files: ["src/main.ts", "tests/project-switch.test.ts"], question: "No decision needed. Let this task continue while you work elsewhere.", check: "Not run · work in progress", log: "Read project activation and editor state.\nAdded restoration cases for inactive projects.\nRunning focused tests before returning a result.", diff: ["  function activateProject(project) {", "-   activeTerminal = firstTerminal(project);", "+   activeTerminal = lastViewedTerminal(project);", "    restoreEditor(project);", "  }"] },
    { id: "shortcuts", project: "termina", title: "Make every action searchable", status: "working", description: "Connecting existing actions to one palette.", agent: "Agent 02", area: "Separate · action-search", elapsed: "2m 38s", files: ["shared/commands.ts"], question: "Working independently. No files are being applied to the project here.", check: "Not run · work in progress", log: "Inspecting the canonical command registry.\nChecking main-process actions and availability.\nAdding keyboard-only scenarios.", diff: ["  const commands = registry.all();", "- const visible = commands.filter(rendererOnly);", "+ const visible = commands.filter(availableHere);", "  renderActions(visible);"] },
    { id: "checkout", project: "storefront", title: "Handle payment retries safely", status: "review", description: "Result available. A human review is still needed.", agent: "Agent 03", area: "Separate · payment-retry", elapsed: "Finished · 8m", files: ["src/checkout/retry.ts", "tests/retry.test.ts", "src/checkout/messages.ts"], question: "Inspect the retry behavior and the sample evidence. Nothing will be applied automatically.", check: "Sample check passed · revision 8", log: "Added idempotency keys for payment retries.\nCovered duplicate requests and expired sessions.\nSample check: 18 assertions passed.\nStopped for review. No changes applied.", diff: ["  async function retryPayment(order) {", "-   return charge(order);", "+   const key = order.paymentAttemptId;", "+   return charge(order, { idempotencyKey: key });", "  }"] },
    { id: "catalog", project: "storefront", title: "Speed up product image loading", status: "working", description: "Checking layout shifts on slow connections.", agent: "Agent 04", area: "Separate · image-loading", elapsed: "6m 05s", files: ["src/catalog/image.ts"], question: "No decision needed. The result will wait for your review.", check: "Not run · work in progress", log: "Read the catalog rendering path.\nAdded image dimensions and deferred offscreen images.\nChecking empty image and slow-network cases.", diff: ["  renderImage(product, {", "+   width: product.imageWidth,", "+   height: product.imageHeight,", "+   loading: 'lazy',", "  });"] },
    { id: "cancel", project: "platform", title: "Add upload cancellation", status: "blocked", description: "Waiting for an API behavior decision.", agent: "Agent 05", area: "Separate · upload-cancel", elapsed: "Waiting · 3m", files: ["src/uploads/cancel.ts", "tests/uploads.test.ts"], question: "When an upload is cancelled twice, should the second request succeed or return a conflict? The agent has paused instead of guessing.", check: "Not run · waiting for decision", log: "Read the existing upload API contract.\nFound no defined response for repeated cancellation.\nPaused before changing the public behavior.\nDecision needed: idempotent success or conflict?", diff: ["  async function cancelUpload(upload) {", "    if (upload.cancelled) {", "-     throw new ConflictError();", "+     // Behavior awaits your decision.", "    }", "  }"] },
    { id: "pagination", project: "platform", title: "Cover cursor pagination boundaries", status: "working", description: "Testing empty pages and deleted cursors.", agent: "Agent 06", area: "Separate · cursor-tests", elapsed: "1m 47s", files: ["tests/pagination.test.ts"], question: "This task has no pending decision. Its test work is separate from the upload task.", check: "Not run · work in progress", log: "Inspecting the cursor pagination contract.\nAdding an empty final page case.\nChecking deleted and invalid cursor behavior.", diff: ["  describe('cursor pagination', () => {", "+   it('returns an empty final page', async () => {", "+     expect(await nextPage(lastCursor)).toEqual([]);", "+   });", "  });"] },
  ];
  const statusNames = { working: "Working", blocked: "Needs a decision", review: "Ready for review", conflict: "File overlap", interrupted: "Interrupted", queued: "Queued", done: "Reviewed · not applied" };
  let state;
  let statusTimer;
  let dialogTrigger;
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const taskById = (id) => state.tasks.find((task) => task.id === id);
  const selectedTask = () => taskById(state.selected);
  const projectById = (id) => state.projects.find((project) => project.id === id);
  const needsAttention = (task) => ["blocked", "review", "conflict", "interrupted"].includes(task.status);
  const taskStatus = (task) => `<span class="task-status ${task.status}">${statusNames[task.status]}</span>`;

  function reset(scenario = "normal") {
    state = { projects: structuredClone(projects), tasks: structuredClone(sampleTasks), project: null, selected: "cancel", view: "overview", scenario, file: 0 };
    if (scenario === "overlap") {
      const task = taskById("shortcuts");
      Object.assign(task, { status: "conflict", area: "Project files · shared", description: "Another task owns shared/commands.ts.", question: "This task and Context switch both need shared/commands.ts. Do not run them as competing writers in the same files. Continue in a separate work area, or keep this task paused.", check: "Not run · overlap unresolved" });
      state.selected = task.id;
    } else if (scenario === "recovery") {
      const task = taskById("tabs");
      Object.assign(task, { status: "interrupted", description: "Session found. A live process has not been confirmed.", question: "The task history is available, but the prior process did not survive restart. Inspect the last checkpoint before explicitly resuming. Unsaved editor drafts are not claimed to be recovered.", check: "Previous check is stale · source not confirmed" });
      state.selected = task.id;
    } else if (scenario === "empty") {
      state.projects = [];
      state.tasks = [];
      state.selected = null;
    }
    render();
  }

  function announce(message) {
    clearTimeout(statusTimer);
    byId("demo-status").textContent = message;
    byId("demo-status").classList.add("visible");
    statusTimer = setTimeout(() => byId("demo-status").classList.remove("visible"), 5500);
  }

  function renderRail() {
    byId("overview-count").textContent = state.projects.length;
    document.querySelector(".overview-link").setAttribute("aria-current", state.project ? "false" : "page");
    byId("project-list").innerHTML = state.projects.map((project) => {
      const tasks = state.tasks.filter((task) => task.project === project.id);
      const running = tasks.filter((task) => task.status === "working").length;
      const attention = tasks.filter(needsAttention).length;
      return `<button class="project-link" data-project="${project.id}" aria-current="${state.project === project.id ? "page" : "false"}" title="${escape(project.path)}"><span class="project-monogram">${escape(project.initial)}</span><span class="project-link-text"><strong>${escape(project.name)}</strong><small>${running} working${attention ? ` · ${attention} needs attention` : tasks.length ? " · no decisions" : " · no tasks yet"}</small></span>${attention ? `<span class="attention-marker" aria-label="${attention} tasks need attention">${attention}</span>` : ""}</button>`;
    }).join("");
  }

  function renderAttention() {
    const priority = { conflict: 0, blocked: 1, interrupted: 2, review: 3 };
    const tasks = state.tasks.filter(needsAttention).sort((a, b) => priority[a.status] - priority[b.status]);
    byId("attention-count").textContent = tasks.length;
    byId("attention-list").innerHTML = tasks.length ? tasks.map((task) => {
      const title = task.status === "review" ? "REVIEW A RESULT" : task.status === "conflict" ? "RESOLVE AN OVERLAP" : task.status === "interrupted" ? "RECOVER A TASK" : "UNBLOCK AN AGENT";
      const action = task.status === "review" ? "Inspect result" : task.status === "conflict" ? "Inspect overlap" : task.status === "interrupted" ? "Inspect checkpoint" : "Make a decision";
      return `<button class="attention-card ${task.status === "review" ? "review" : ""} ${task.id === state.selected ? "selected" : ""}" data-task="${task.id}" aria-pressed="${task.id === state.selected}"><span class="attention-kind">${title}</span><span class="attention-context"><span>${escape(projectById(task.project).name)} / ${task.agent}</span><span>${escape(task.elapsed)}</span></span><strong>${escape(task.title)}</strong><span class="attention-copy">${escape(task.description)}</span><span class="attention-cta">${action} <span aria-hidden="true">↗</span></span></button>`;
    }).join("") : `<p class="attention-empty">${state.projects.length ? "No unresolved decisions. Working tasks can continue; their results will wait here for review." : "Your first project starts here. Nothing is running in the background."}</p>`;
  }

  function renderOverview() {
    if (!state.projects.length) {
      byId("work-content").innerHTML = `<section class="empty-workspace"><span class="eyebrow">A QUIET START</span><h2>Your work. One place.</h2><p>Open a project, connect the agent in its terminal, then give it an outcome. Add more projects when you need them—not before.</p><div class="setup-step"><span class="step-number">1</span><div><h3>Open a project</h3><p>Files and a shell are useful even before a provider is connected.</p></div></div><div class="setup-step"><span class="step-number">2</span><div><h3>Connect in the terminal</h3><p>The existing /login flow stays the source of truth. This prototype has no credentials or network access.</p></div></div><button class="primary-button" data-action="add-project">Open sample project</button></section>`;
      return;
    }
    const visible = state.projects.filter((project) => !state.project || project.id === state.project);
    byId("work-content").innerHTML = visible.map((project) => {
      const tasks = state.tasks.filter((task) => task.project === project.id);
      const rows = tasks.map((task) => `<button class="task-card ${task.id === state.selected ? "selected" : ""}" data-task="${task.id}" aria-pressed="${task.id === state.selected}"><span class="task-card-top">${taskStatus(task)}<span class="task-elapsed">${escape(task.elapsed)}</span></span><h3>${escape(task.title)}</h3><p class="task-description">${escape(task.description)}</p><span class="task-meta"><span>${escape(task.agent)}</span><span class="area-label" title="${escape(task.area)}">⑂ ${escape(task.area)}</span></span></button>`).join("");
      return `<section class="project-lane" aria-label="${escape(project.name)} tasks"><div class="lane-header"><div class="lane-identity"><span class="project-monogram">${escape(project.initial)}</span><strong>${escape(project.name)}</strong><span class="path">${escape(project.path)}</span></div><button class="quiet-button" data-new-project-task="${project.id}" aria-label="New task in ${escape(project.name)}">＋ Task</button></div>${tasks.length ? `<div class="task-grid">${rows}</div>` : `<div class="attention-empty">No tasks yet. Start with one clear outcome.</div>`}</section>`;
    }).join("");
  }

  function renderFocus() {
    const task = selectedTask();
    if (!task) { renderOverview(); return; }
    const project = projectById(task.project);
    const file = task.files[state.file] ?? task.files[0] ?? "No file changes yet";
    const files = task.files.map((name, index) => `<button class="file-entry ${index === state.file ? "selected" : ""}" data-file="${index}" aria-pressed="${index === state.file}" title="${escape(name)}"><span class="file-name">${escape(name)}</span><span class="file-stats">sample diff</span></button>`).join("");
    const lines = state.file === 0 ? task.diff : ["  // Sample test excerpt", "+ it('covers the task boundary', () => {", "+   expect(sampleResult).toBeDefined();", "+ });"];
    const diff = lines.map((line) => `<span class="diff-line ${line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : ""}">${escape(line)}</span>`).join("");
    byId("work-content").innerHTML = `<section aria-label="Focused task"><div class="focus-heading"><span class="project-monogram">${project.initial}</span><strong>${escape(project.name)} / ${escape(task.title)}</strong>${taskStatus(task)}</div><div class="focus-split"><div class="focus-panel"><div class="focus-panel-title">${task.agent} · SIMULATED TERMINAL</div><div class="terminal-output"><span class="tool-line">› ${escape(task.title)}</span>\n\n${escape(task.log)}\n\n<strong>${needsAttention(task) ? "Waiting for your action." : "You can focus elsewhere. This task stays here."}</strong></div><form class="terminal-composer" id="follow-up-form"><textarea aria-label="Sample follow-up" rows="2" required maxlength="500" placeholder="Queue a sample follow-up…"></textarea><button type="submit" class="secondary-button">Queue</button></form></div><div class="focus-panel"><div class="focus-panel-title">CHANGES · ${task.files.length} FILES · NOT APPLIED</div>${files}<div class="diff-code" aria-label="Sample diff for ${escape(file)}">${diff}</div><div class="evidence-strip"><strong>${escape(task.check)}</strong><br>Evidence belongs to a source revision, not an agent's claim.<br><button class="quiet-button" data-action="checks">Inspect sample check →</button></div></div></div><div class="focus-tail"><span>⑂ ${escape(task.area)}</span><span>PROJECT: ${escape(project.path)}</span><button class="quiet-button" data-action="view-overview">← Back to work overview</button></div></section>`;
  }

  function renderInspector() {
    const task = selectedTask();
    if (!task) {
      byId("inspector").innerHTML = `<div class="inspector-heading"><span>CONTEXT, NOT CLUTTER</span><span aria-hidden="true">↳</span></div><h2>Start small.<br>Stay in control.</h2><p class="task-context">Your terminal, editor, and changes come together around one task. Other projects remain visible without competing for your focus.</p><div class="decision-box"><span class="eyebrow">FIRST VALUE</span><p>Open a project. You do not need to configure a team of agents before doing useful work.</p></div><div class="inspector-foot">This is a <strong>presentation-only concept.</strong> It does not open real folders, connect a provider, or start a process.</div>`;
      return;
    }
    const project = projectById(task.project);
    let primary = `<button class="primary-button" data-action="open-task">Open task →</button>`;
    if (task.status === "blocked") primary = `<button class="primary-button" data-action="decide">Choose API behavior →</button>`;
    if (task.status === "conflict") primary = `<button class="primary-button" data-action="separate">Use separate work area →</button>`;
    if (task.status === "interrupted") primary = `<button class="primary-button" data-action="resume">Inspect checkpoint →</button>`;
    if (task.status === "review") primary = `<button class="primary-button" data-action="open-task">Review ${task.files.length} changed files →</button>`;
    if (task.status === "review" && state.view === "focus") primary = `<button class="primary-button" data-action="mark-reviewed">Mark reviewed · do not apply</button>`;
    if (task.status === "queued") primary = `<button class="primary-button" data-action="start-sample">Start sample task →</button>`;
    const extra = task.status === "working" ? `<button class="secondary-button" data-action="sample-check">Finish & run sample check</button>` : task.status === "done" ? `<button class="secondary-button" data-action="handoff">Inspect handoff</button>` : "";
    byId("inspector").innerHTML = `<div class="inspector-heading"><span>SELECTED TASK</span><span aria-hidden="true">↳</span></div>${taskStatus(task)}<h2>${escape(task.title)}</h2><p class="task-context">${escape(project.name)} / ${task.agent}<br>${escape(project.path)}</p><div class="decision-box"><span class="eyebrow">${needsAttention(task) ? "YOUR NEXT ACTION" : "CURRENT CONTEXT"}</span><p>${escape(task.question)}</p></div><dl><dt>WORKING IN</dt><dd>⑂ ${escape(task.area)}</dd><dt>TOUCHED FILES</dt><dd>${task.files.map(escape).join("<br>") || "None yet"}</dd><dt>VERIFICATION</dt><dd>${escape(task.check)}</dd></dl>${primary}${state.view !== "focus" && needsAttention(task) && task.status !== "review" ? `<button class="secondary-button" data-action="open-task">Open terminal & changes</button>` : ""}${extra}<button class="quiet-button" data-action="checks">Inspect check details →</button><p class="evidence-caption">All checks and activity shown here are samples. Idle never means verified.</p><div class="inspector-foot"><strong>Focus is a view, not a process owner.</strong><br>Switching projects does not stop work. Review does not stage, commit, or apply files.</div>`;
  }

  function render() {
    renderRail();
    renderAttention();
    const project = projectById(state.project);
    const task = selectedTask();
    const focus = state.view === "focus" && task;
    byId("breadcrumb").textContent = focus ? `WORKSPACE / ${projectById(task.project).name.toUpperCase()} / TASK` : `WORKSPACE / ${project ? project.name.toUpperCase() : "ALL PROJECTS"}`;
    byId("view-title").textContent = focus ? "One task. Full context." : project ? project.name : "Keep the work moving.";
    byId("view-subtitle").textContent = focus ? "The terminal remains the source of truth. Other decisions stay in view." : project ? `${project.context} · background work continues across all projects.` : "Your attention is the bottleneck. Not the number of terminals.";
    byId("work-summary").textContent = `${state.tasks.filter((item) => item.status === "working").length} working · ${state.projects.length} projects · sample data`;
    document.querySelector('[data-action="view-overview"]').setAttribute("aria-pressed", !focus);
    document.querySelector('[data-action="view-focus"]').setAttribute("aria-pressed", Boolean(focus));
    document.querySelector('[data-action="view-focus"]').disabled = !task;
    document.querySelectorAll("[data-scenario]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.scenario === state.scenario));
    if (focus) renderFocus(); else renderOverview();
    renderInspector();
  }

  function openDialog(id) {
    dialogTrigger = document.activeElement;
    byId(id).showModal();
  }

  function info(title, content) {
    byId("info-title").textContent = title;
    byId("info-content").innerHTML = content;
    openDialog("info-dialog");
  }

  function openNewTask(projectId) {
    if (!state.projects.length) { addProject(); }
    byId("task-project").innerHTML = state.projects.map((project) => `<option value="${project.id}">${escape(project.name)}</option>`).join("");
    byId("task-project").value = projectId ?? state.project ?? state.projects[0].id;
    byId("task-goal").value = "";
    openDialog("task-dialog");
    byId("task-goal").focus();
  }

  function addProject() {
    const id = `sample-${state.projects.length + 1}`;
    state.projects.push({ id, name: "sample-project", initial: "S", path: `~/projects/${id}`, context: "Sample project · no live folder" });
    state.project = id;
    state.selected = null;
    state.view = "overview";
    render();
    announce("Sample project opened. No real folder or agent was opened.");
  }

  function renderSearch() {
    const query = byId("workspace-search").value.trim().toLowerCase();
    const projectRows = state.projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query)).map((project) => `<button class="jump-result" data-project="${project.id}"><span>${escape(project.name)}</span><small>Project</small></button>`);
    const taskRows = state.tasks.filter((task) => `${task.title} ${projectById(task.project).name} ${task.agent}`.toLowerCase().includes(query)).map((task) => `<button class="jump-result" data-jump-task="${task.id}"><span>${escape(task.title)}</span><small>${escape(projectById(task.project).name)}</small></button>`);
    byId("search-results").innerHTML = [...projectRows, ...taskRows].join("") || `<p class="dim small">No matching projects or tasks in this sample workspace.</p>`;
  }

  function openTask(task = selectedTask()) {
    if (!task) return;
    state.selected = task.id;
    state.project = task.project;
    state.view = "focus";
    state.file = 0;
    render();
    byId("workspace").focus();
  }

  const actions = {
    overview() { state.project = null; state.view = "overview"; render(); },
    "view-overview"() { state.view = "overview"; render(); },
    "view-focus"() { openTask(); },
    "open-task"() { openTask(); },
    "new-task"() { openNewTask(); },
    "add-project": addProject,
    reset() { reset(state.scenario); announce("Sample workspace reset."); },
    "close-dialog"() { document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()); },
    search() { byId("workspace-search").value = ""; renderSearch(); openDialog("search-dialog"); byId("workspace-search").focus(); },
    guide() { info("Manage attention, not terminal tabs.", "<p>All projects is your overview. Select a task to see its work area and next action. Focus task brings its simulated terminal, changes, and checks together.</p><p>Decisions remain across project switches. File overlap and restart are deliberate edge-case scenarios. New tasks and follow-ups update only memory in this page; refresh or Reset discards the sample.</p><p>No provider calls, real PTYs, filesystem writes, Git operations, sandboxes, or persistent settings are connected. This is a proposed interface, not shipped functionality.</p>"); },
    decide() {
      info("Define repeated cancellation", `<p>The upload task is paused. Choose the behavior you want the agent to implement.</p><div class="work-area-note"><div><strong>Idempotent success</strong><p>Repeated cancellation returns 204. A retry does not become an error.</p></div></div><div class="work-area-note"><div><strong>Conflict response</strong><p>Repeated cancellation returns 409. Clients must distinguish an already-cancelled upload.</p></div></div><div class="dialog-actions"><button class="secondary-button" data-decision="conflict">Return 409</button><button class="primary-button" data-decision="idempotent">Return 204</button></div><p>No API is called. This records a sample decision only.</p>`);
    },
    separate() {
      const task = selectedTask();
      if (!task || task.status !== "conflict") return;
      task.status = "queued";
      task.area = "Separate · action-search";
      task.description = "Queued in a separate sample work area.";
      task.question = "Overlap resolved in this simulation. No actual copy or sandbox has been created. Start the sample task when ready.";
      task.check = "Not run · queued";
      render();
      announce("Sample task separated. No files copied and no sandbox created.");
    },
    resume() { info("Inspect the last checkpoint", `<p>Recovered: task history and last recorded file list.</p><p>Not confirmed: a live agent process, current verification, or unsaved editor drafts. Do not label this task as still running.</p><p>Resume from the inspected checkpoint in this simulation. In production, source and process identity must be reconciled first.</p><button class="primary-button" data-action="confirm-resume">Resume sample task</button>`); },
    "confirm-resume"() {
      const task = selectedTask();
      if (!task || task.status !== "interrupted") return;
      task.status = "working";
      task.description = "Resumed from an inspected sample checkpoint.";
      task.question = "The sample task is working again. Previous checks remain stale until rerun.";
      task.elapsed = "Resumed · now";
      byId("info-dialog").close();
      render();
      announce("Sample task resumed. Previous evidence remains stale.");
    },
    "start-sample"() {
      const task = selectedTask();
      if (!task || task.status !== "queued") return;
      task.status = "working";
      task.agent = "Sample agent";
      task.elapsed = "Started · now";
      task.description = "Working in this simulation only.";
      task.question = "The simulated task is working. No live agent or process was started.";
      task.log += "\nSample task started. No live process exists.";
      render();
      announce("Sample task started. No live process exists.");
    },
    "sample-check"() {
      const task = selectedTask();
      if (!task || task.status !== "working") return;
      task.status = "review";
      task.description = "Sample result available. Review before applying.";
      task.check = "Sample check passed · revision 8";
      task.question = "A simulated check passed on revision 8. Review remains a separate human action, and no changes have been applied.";
      task.elapsed = "Finished · now";
      task.log += "\nSample check passed on revision 8. Stopped for review.";
      render();
      announce("Sample check passed. No real tests ran; review is still required.");
    },
    "mark-reviewed"() {
      const task = selectedTask();
      if (!task || task.status !== "review") return;
      task.status = "done";
      task.question = "Review recorded in this page. No files were applied, staged, or committed. Inspect the handoff for the proposed next step.";
      task.description = "Reviewed in the demo. Nothing applied.";
      render();
      announce("Sample review recorded. No files applied, staged, or committed.");
    },
    handoff() { info("Review is not a commit", "<p>This sample result is reviewed, but not applied. A production handoff should name the target project, show the exact diff and fresh verification, and require an explicit apply operation.</p><p>Termina's application Git/snapshot behavior remains owned by the existing Rust core. Staging and committing in your repository remain your choice.</p><p>This prototype performs none of those operations.</p>"); },
    checks() {
      const task = selectedTask();
      if (!task) return;
      info("Evidence you can inspect", `<p><strong>${escape(task.check)}</strong></p><dl><dt>Project / task</dt><dd>${escape(projectById(task.project).name)} / ${escape(task.title)}</dd><dt>Illustrative command</dt><dd><code>pnpm exec vitest run tests/task.test.ts</code></dd><dt>Source relevance</dt><dd>${task.check.includes("revision 8") ? "Sample revision 8 · 18 assertions passed · exit 0" : task.check.includes("stale") ? "Stale. Current source has not been confirmed." : "No passing check for the current sample result."}</dd></dl><p>The command, source revision, and output are illustrative—not evidence from a real run. Production should show actual output, exit status, duration, truncation, and source changes since the check.</p>`);
    },
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.scenario) { reset(button.dataset.scenario); return; }
    if (button.dataset.project) {
      state.project = button.dataset.project;
      state.view = "overview";
      state.selected = state.tasks.find((task) => task.project === state.project)?.id ?? null;
      byId("search-dialog").close();
      render();
      return;
    }
    if (button.dataset.task) {
      state.selected = button.dataset.task;
      state.file = 0;
      if (state.view === "focus") state.project = selectedTask().project;
      render();
      return;
    }
    if (button.dataset.jumpTask) { byId("search-dialog").close(); openTask(taskById(button.dataset.jumpTask)); return; }
    if (button.dataset.newProjectTask) { openNewTask(button.dataset.newProjectTask); return; }
    if (button.dataset.file !== undefined) { state.file = Number(button.dataset.file); renderFocus(); return; }
    if (button.dataset.decision) {
      const task = selectedTask();
      if (!task || task.status !== "blocked") return;
      const choice = button.dataset.decision === "idempotent" ? "204 idempotent success" : "409 conflict";
      task.status = "working";
      task.description = `Implementing your choice: ${choice}.`;
      task.question = `Decision recorded: ${choice}. The sample task continues. Nothing has been sent to a live agent.`;
      task.log += `\nUser decision: ${choice}. Continuing in the sample.`;
      task.elapsed = "Resumed · now";
      task.check = "Not run · behavior changed";
      byId("info-dialog").close();
      render();
      announce(`Sample decision recorded: ${choice}.`);
      return;
    }
    actions[button.dataset.action]?.();
  });

  byId("task-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = byId("task-goal").value.trim();
    if (!title) { byId("task-goal").setCustomValidity("Enter a task outcome, not only spaces."); byId("task-goal").reportValidity(); return; }
    const id = `task-${state.tasks.length + 1}`;
    state.tasks.push({ id, project: byId("task-project").value, title, status: "queued", description: "Queued sample task. No agent has started.", agent: "Unassigned", area: "Separate · new-task", elapsed: "Queued · now", files: [], question: "This sample task is queued. No agent has started. In production, admission and available capacity must be confirmed before a task is called working.", check: "Not run · queued", log: "Task queued. No process started.", diff: ["  // No changes yet."] });
    state.selected = id;
    state.project = byId("task-project").value;
    state.view = "overview";
    byId("task-dialog").close();
    render();
    announce("Sample task queued. No live agent started.");
  });
  byId("task-goal").addEventListener("input", () => byId("task-goal").setCustomValidity(""));
  byId("workspace-search").addEventListener("input", renderSearch);
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "follow-up-form") return;
    event.preventDefault();
    const task = selectedTask();
    const input = event.target.querySelector("textarea");
    const text = input.value.trim();
    if (!text) { input.setCustomValidity("Enter a follow-up, not only spaces."); input.reportValidity(); return; }
    task.log += `\nQueued sample follow-up: ${text}`;
    renderFocus();
    announce("Sample follow-up queued. No message sent to a live agent.");
  });
  document.addEventListener("input", (event) => {
    if (event.target.closest("#follow-up-form")) event.target.setCustomValidity("");
  });
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
    if (dialogTrigger?.isConnected) dialogTrigger.focus();
    else document.querySelector('[data-action="overview"]').focus();
  }));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      actions.search();
    }
  });
  reset();
})();
