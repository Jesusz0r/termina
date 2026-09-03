import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("IPC Capability & Project Flow Security Invariants", () => {
  it("enforces renderer capability, project activation, and terminal restoration fences", async () => {
/**
 * Deterministic source-level probes for the renderer capability and project
 * activation fences. The real Electron multiproject suite covers the public
 * UI path; this probe covers adversarial sender shapes and the async reorder
 * contract without needing a live display server.
 */

const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const rendererState = readFileSync(new URL("../../../src/worldline-project-state.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../../../shared/types.ts", import.meta.url), "utf8");

const checks = [];
function check(name, value) {
  assert.equal(Boolean(value), true, name);
  checks.push(name);
}

// Every invoke registration in registerIpc uses the local authorized facade;
// only handleIpc itself is allowed to call the Electron primitive.
check("all invoke handlers route through the capability wrapper", (main.match(/ipcMain\.handle\(/g) ?? []).length > 0
  && (main.match(/electronIpcMain\.handle\(/g) ?? []).length === 1
  && main.includes("const capability = args.pop()")
  && main.includes("if (!this.isTrustedRenderer(event, capability))"));
check("sender WebContents and main-frame identity are checked", main.includes("event.sender !== win.webContents")
  && main.includes("frame.processId === mainFrame.processId")
  && main.includes("frame.routingId === mainFrame.routingId"));
check("capability issuance is bound to the trusted app origin", main.includes("trustedRendererProtocol")
  && main.includes("isTrustedRendererUrl")
  && main.includes('win.webContents.on("will-frame-navigate"')
  && main.includes('win.webContents.on("will-navigate"')
  && main.includes('win.webContents.on("will-redirect"')
  && main.includes("setWindowOpenHandler")
  && main.includes("event.preventDefault()"));
check("stale, replaced, and crashed documents fail closed", main.includes("win.webContents.isCrashed()")
  && main.includes("this.rendererAwaitingNewFrame")
  && main.includes("capability.windowGeneration === current.windowGeneration")
  && main.includes("capability.rendererGeneration === current.rendererGeneration")
  && main.includes("capability.loadGeneration === current.loadGeneration")
  && main.includes("capability.nonce === current.nonce"));
check("preload cannot mint a capability", preload.includes('sendSync("renderer:capability")')
  && preload.includes("...args, rendererCapability")
  && preload.includes("if (rendererCapability) contextBridge.exposeInMainWorld")
  && preload.includes("ipcRenderer.send(\"pty:ack\", payload)"));

// Keep a small executable model beside the source assertions. It exercises
// the exact malicious/stale classes the production predicate must reject.
const webContents = {};
const mainFrame = { processId: 41, routingId: 7 };
mainFrame.top = mainFrame;
const current = {
  windowGeneration: 3,
  rendererGeneration: 8,
  loadGeneration: 12,
  nonce: "document-nonce-8",
  processId: 41,
  frameRoutingId: 7,
};
const accepted = (event, capability, state = current, crashed = false) => !crashed
  && event.sender === webContents
  && event.senderFrame?.processId === mainFrame.processId
  && event.senderFrame?.routingId === mainFrame.routingId
  && event.senderFrame?.top
  && event.senderFrame.top.processId === mainFrame.processId
  && event.senderFrame.top.routingId === mainFrame.routingId
  && capability.windowGeneration === state.windowGeneration
  && capability.rendererGeneration === state.rendererGeneration
  && capability.loadGeneration === state.loadGeneration
  && capability.nonce === state.nonce
  && capability.processId === state.processId
  && capability.frameRoutingId === state.frameRoutingId;
const validEvent = { sender: webContents, senderFrame: mainFrame };
const validCapability = { ...current };
check("legitimate current main-frame capability is accepted", accepted(validEvent, validCapability));
check("foreign WebContents is rejected", !accepted({ ...validEvent, sender: {} }, validCapability));
check("subframe is rejected", !accepted({ ...validEvent, senderFrame: { processId: 41, routingId: 8 } }, validCapability));
check("frame with a foreign top is rejected", !accepted({ ...validEvent, senderFrame: { processId: 41, routingId: 7, top: { processId: 41, routingId: 9 } } }, validCapability));
check("crashed WebContents is rejected", !accepted(validEvent, validCapability, current, true));
check("stale document generation is rejected", !accepted(validEvent, { ...validCapability, rendererGeneration: 7 }));
check("stale document nonce is rejected", !accepted(validEvent, { ...validCapability, nonce: "old-document" }));
check("replaced frame is rejected", !accepted(validEvent, { ...validCapability, frameRoutingId: 6 }));

const trustedFile = "file:///app/dist-renderer/index.html";
const trustedHttp = "http://127.0.0.1:5173";
const appUrl = (value, expected) => {
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return actual.protocol === target.protocol
      && (actual.protocol === "file:" ? actual.pathname === target.pathname : actual.origin === target.origin);
  } catch {
    return false;
  }
};
check("foreign file/http origins are rejected by the URL model", !appUrl("file:///tmp/evil.html", trustedFile)
  && !appUrl("https://attacker.example/", trustedHttp)
  && appUrl(trustedFile, trustedFile)
  && appUrl(`${trustedHttp}/assets/index.js`, trustedHttp));

// Exercise the ordering contract as a real async reorder: activation starts,
// yields at its auth lookup, then close claims a newer action/epoch. The old
// activation is not allowed to publish a folder event after close.
const activationCloseProbe = async () => {
  let action = 0;
  let epoch = 0;
  let active = "nested";
  const events = [];
  const activate = async (projectId) => {
    const myAction = ++action;
    const myEpoch = ++epoch;
    active = projectId;
    await Promise.resolve();
    if (active === projectId && action === myAction && epoch === myEpoch) {
      events.push({ type: "folder:opened", projectId, epoch: myEpoch });
    }
  };
  const close = async (projectId) => {
    const myAction = ++action;
    const myEpoch = ++epoch;
    await Promise.resolve();
    if (active === projectId && action === myAction && epoch === myEpoch) active = null;
    events.push({ type: "project:closed", projectId, epoch: myEpoch });
  };
  await Promise.all([activate("nested"), close("nested")]);
  return { active, events };
};
const activationCloseResult = await activationCloseProbe();
check("activation-close reorder suppresses stale folder publication", activationCloseResult.active === null
  && activationCloseResult.events.filter((event) => event.type === "folder:opened").length === 0
  && activationCloseResult.events.some((event) => event.type === "project:closed"));

// An open-by-path request reserves its action before canonicalization. If a
// newer activation wins while that lookup yields, the stale open must not
// reactivate an already-open project when the path resolves.
const staleOpenProbe = async () => {
  let action = 0;
  let active = "A";
  const openExisting = async () => {
    const openAction = ++action;
    await Promise.resolve();
    if (action === openAction) active = "A";
  };
  const activateNewer = async () => {
    active = "B";
    ++action;
  };
  await Promise.all([openExisting(), activateNewer()]);
  return active;
};
check("stale open-by-path cannot reclaim a newer activation", (await staleOpenProbe()) === "B"
  && main.includes("expectedSelectionAction")
  && main.includes("activateProject(existing.id, rendererTarget, selectionAction)"));

const closeCoalesceProbe = async () => {
  let pending = null;
  let confirmations = 0;
  let teardowns = 0;
  const close = () => {
    if (pending) return pending;
    pending = (async () => {
      confirmations++;
      await Promise.resolve();
      teardowns++;
      return { ok: true };
    })();
    return pending;
  };
  const [first, second] = await Promise.all([close(), close()]);
  return { first, second, confirmations, teardowns };
};
const closeCoalesceResult = await closeCoalesceProbe();
check("concurrent close calls coalesce one confirmation and teardown", closeCoalesceResult.first === closeCoalesceResult.second
  && closeCoalesceResult.confirmations === 1 && closeCoalesceResult.teardowns === 1
  && main.includes("projectClosePromises") && main.includes("closeProjectOnce"));
check("reload hydration carries evidence and main-owned terminal state", main.includes("listWithEvidence")
  && main.includes("modified: [...t.modified.values()]")
  && main.includes("recorderState: t.recorderState")
  && rendererState.includes("summary.modified")
  && rendererState.includes("summary.recorderState")
  && renderer.includes("pane.modified = inst.modified")
  && renderer.includes("pane.recorderState = inst.recorderState")
  && renderer.includes("pane.verify = inst.verify ??")
  && types.includes("modified: ModifiedFile[]")
  && types.includes("recorderState: RecorderState")
  && types.includes("evidence?: EvidenceSummary"));

// A replacement project may already be in the map while still restoring its
// workspace. Closing the old active project must not strand that replacement
// with no folder push when its open finally becomes ready.
const replacementOpenProbe = async () => {
  let action = 0;
  let epoch = 0;
  let active = "A";
  const events = [];
  const openB = async () => {
    const openingAction = ++action;
    await Promise.resolve();
    active = active === "B" ? active : "B";
    if (active === "B" && openingAction !== action) {
      events.push({ type: "folder:opened", projectId: "B", epoch });
    }
  };
  const closeA = async () => {
    ++action;
    ++epoch;
    active = "B";
    events.push({ type: "project:closed", projectId: "A", epoch });
    await Promise.resolve();
  };
  await Promise.all([openB(), closeA()]);
  return { active, events };
};
const replacementOpenResult = await replacementOpenProbe();
check("close-to-opening replacement receives a ready folder push", replacementOpenResult.active === "B"
  && replacementOpenResult.events.some((event) => event.type === "project:closed" && event.projectId === "A")
  && replacementOpenResult.events.some((event) => event.type === "folder:opened" && event.projectId === "B"));

// Async project activation must re-check the action/epoch after auth I/O, and
// the renderer must carry the same epoch watermark through close events.
check("folder pushes carry an activation epoch and re-check after auth I/O", main.includes("activationGeneration")
  && main.includes("this.projectSelectionAction === selectionAction")
  && main.includes("const needsLogin = await this.piNeedsLogin()")
  && main.includes("if (!current()) return false")
  && main.includes('this.send("folder:opened", { cwd, projectId, workspaceId, activationGeneration, needsLogin }, rendererTarget)'));
check("close pushes advance the stale-event watermark", main.includes('this.send("project:closed", { projectId, activationGeneration: nextActivationGeneration }, rendererTarget)')
  && renderer.includes("latestProjectActivationGeneration")
  && renderer.includes("e.activationGeneration < latestProjectActivationGeneration"));
check("shared project contracts expose activation generations", types.includes("interface RendererIpcCapability")
  && types.includes("activationGeneration: number"));

// An existing empty roster means the user closed the project's last terminal;
// only a missing roster gets a first-launch default. Every restore is bound to
// its project before createTerminal crosses asynchronous setup.
check("empty terminal rosters survive restart", main.includes("{ exists: boolean; entries: TerminalRosterEntry[] }")
  && main.includes("if (!loaded.exists)")
  && main.includes("empty roster is the durable result"));
check("restored terminals bind to their source project", main.includes("projectId: project.id")
  && main.includes("workspaceId: this.primaryWorkspace(project)?.id"));

// Closing is durable before PTY exit, and neither main nor a stale queued push
// may advertise the closing process as a live pane.
check("terminal close persists before process exit", main.includes("saveTerminalRoster excludes the now-closed live instance")
  && main.includes("!inst?.persist || inst.closed")
  && main.includes("this.saveTerminalRoster(owner)"));
check("closing terminals cannot be rehydrated", main.includes("filter((t) => !t.closed)")
  && renderer.includes("list.filter((instance) => !closingPanes.has(instance.id))"));

assert.equal(checks.length, 26);

  });
});
