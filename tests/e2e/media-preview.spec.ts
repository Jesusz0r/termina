import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";
import { previewMediaUrl } from "../../shared/preview-media.ts";

const binaryBytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff]);
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function twoPagePdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 5 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test.beforeEach(async ({ projectRoot }) => {
  writeFileSync(join(projectRoot, "archive.zip"), binaryBytes);
  writeFileSync(join(projectRoot, "large.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="steelblue"/><circle cx="1200" cy="800" r="300" fill="white"/></svg>');
  writeFileSync(join(projectRoot, "broken.png"), "not an image");
  writeFileSync(join(projectRoot, "pixel.png"), pngBytes);
  writeFileSync(join(projectRoot, "empty.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>');
  writeFileSync(join(projectRoot, "pages.pdf"), twoPagePdf());
  symlinkSync("large.svg", join(projectRoot, "not-a-pdf.pdf"));
});

test("binary files are rejected without replacing a text tab or changing bytes", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const path = join(projectRoot, "archive.zip");
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "hello.txt" }).click();
  await expect(page.locator(".editor-tab.active")).toContainText("hello.txt");
  await page.locator('#explorer-tree .explorer-row[data-path$="/archive.zip"]').click();
  await expect(page.locator(".toast").filter({ hasText: /binary|unsupported text encoding/ })).toBeVisible();
  await expect(page.locator(".editor-tab.active")).toContainText("hello.txt");
  await expect(page.locator(".editor-tab").filter({ hasText: "archive.zip" })).toHaveCount(0);
  expect(readFileSync(path)).toEqual(binaryBytes);
});

test("a text file replaced by invalid UTF-8 is not pushed into the editor", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="hello.txt"]').dblclick();
  const lines = page.locator(".editor-container .monaco-editor .view-lines");
  await expect(lines).toContainText("hello");
  const invalid = Buffer.from([0x72, 0xe9, 0x73]); // Invalid UTF-8, without NUL.
  writeFileSync(join(projectRoot, "hello.txt"), invalid);
  await expect(page.locator(".toast").filter({ hasText: /could not refresh hello.txt.*unsupported text encoding/ })).toBeVisible();
  await expect(lines).toContainText("hello");
  await expect(lines).not.toContainText("�");
  expect(readFileSync(join(projectRoot, "hello.txt"))).toEqual(invalid);
  writeFileSync(join(projectRoot, "hello.txt"), "valid again\n");
  await expect(lines).toContainText("valid again");
});

test("double-clicking a new image pins the tab while its first open is in flight", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="large.svg"]').dblclick();
  await expect(page.locator(".editor-tab.active")).toContainText("large.svg");
  await expect(page.locator(".editor-tab.active")).not.toHaveClass(/preview/);
  await page.locator('#explorer-tree .explorer-row[data-name="hello.txt"]').click();
  await expect(page.locator(".editor-tab")).toHaveCount(2);
});

test("image controls support zoom, scrolling, panning, keyboard and tab restoration", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const row = page.locator('#explorer-tree .explorer-row[data-name="large.svg"]');
  await row.click();
  const viewport = page.locator(".image-preview-viewport");
  const zoom = page.getByLabel("Image zoom", { exact: true });
  const actual = page.getByRole("button", { name: "Actual size", exact: true });
  await expect(actual).toBeEnabled();
  await row.dblclick();
  await expect(page.locator(".editor-tab.active")).not.toHaveClass(/preview/);
  await actual.click();
  await expect(zoom).toHaveText("100%");
  await expect.poll(() => viewport.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(zoom).toHaveText("125%");
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(zoom).toHaveText("100%");

  await viewport.evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0; });
  await viewport.hover();
  await page.mouse.wheel(120, 160);
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const before = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 70, box.y + box.height / 2 - 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before.left + 50);
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(before.top + 40);

  // Chromium emits Ctrl+wheel for trackpad pinch as well.
  await viewport.dispatchEvent("wheel", { deltaY: -20, ctrlKey: true, clientX: box.x + 100, clientY: box.y + 100 });
  await expect(zoom).not.toHaveText("100%");
  await viewport.press("0");
  await expect(zoom).toHaveText("100%");
  await viewport.press("+");
  await expect(zoom).toHaveText("125%");
  await viewport.press("-");
  await expect(zoom).toHaveText("100%");
  const saved = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
  await page.locator('#explorer-tree .explorer-row[data-path$="/hello.txt"]').click();
  await expect(viewport).toHaveCount(0);
  await page.locator(".editor-tab").filter({ hasText: "large.svg" }).click();
  await expect(zoom).toHaveText("100%");
  await expect.poll(() => viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))).toEqual(saved);
  await viewport.press("f");
  await expect(page.getByRole("button", { name: "Fit image", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => viewport.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  const fitBeforeResize = await zoom.textContent();
  await page.setViewportSize({ width: 1200, height: 760 });
  await expect(zoom).not.toHaveText(fitBeforeResize!);
  await expect.poll(() => viewport.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.locator(".editor-tab.active .tab-close").click();
  await expect(viewport).toHaveCount(0);
});

test("image refresh preserves hidden pan state and keyboard focus without stealing terminal focus", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="large.svg"]').dblclick();
  const viewport = page.locator(".image-preview-viewport");
  const image = viewport.locator("img");
  const zoom = page.getByLabel("Image zoom", { exact: true });
  await page.getByRole("button", { name: "Actual size", exact: true }).click();
  await viewport.evaluate((el) => { el.scrollLeft = 300; el.scrollTop = 200; });
  await expect.poll(() => viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))).toEqual({ left: 300, top: 200 });
  const rewrite = (revision: number) => writeFileSync(join(projectRoot, "large.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><title>Revision ${revision}</title><rect width="2400" height="1600" fill="steelblue"/></svg>`);
  let previousSrc = await image.getAttribute("src");
  await page.locator("#btn-min-editor").click();
  await expect(viewport).toBeHidden();
  rewrite(1);
  await expect(image).not.toHaveAttribute("src", previousSrc!);
  await page.locator("#btn-min-editor").click();
  await expect(zoom).toHaveText("100%");
  await expect.poll(() => viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }))).toEqual({ left: 300, top: 200 });

  await viewport.focus();
  previousSrc = await image.getAttribute("src");
  rewrite(2);
  await expect(image).not.toHaveAttribute("src", previousSrc!);
  await expect(viewport).toBeFocused();
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
  await page.keyboard.press("+");
  await expect(zoom).toHaveText("125%");

  const actual = page.getByRole("button", { name: "Actual size", exact: true });
  await actual.focus();
  previousSrc = await image.getAttribute("src");
  rewrite(3);
  await expect(image).not.toHaveAttribute("src", previousSrc!);
  await expect(actual).toBeFocused();

  const terminal = page.locator(".term-pane.active .xterm-helper-textarea");
  await terminal.focus();
  previousSrc = await image.getAttribute("src");
  rewrite(4);
  await expect(image).not.toHaveAttribute("src", previousSrc!);
  await expect(actual).toBeEnabled();
  await expect(terminal).toBeFocused();
});

test("binary image rewrites refresh the preview and recover from damaged content", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="pixel.png"]').dblclick();
  const image = page.locator(".image-preview-stage img");
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  await expect(zoomIn).toBeEnabled();
  let src = await image.getAttribute("src");
  const path = join(projectRoot, "pixel.png");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  await expect(image).not.toHaveAttribute("src", src!);
  await expect(page.getByRole("status").filter({ hasText: "could not be loaded" })).toBeVisible();
  await expect(zoomIn).toBeDisabled();
  src = await image.getAttribute("src");
  writeFileSync(path, pngBytes);
  await expect(image).not.toHaveAttribute("src", src!);
  await expect(zoomIn).toBeEnabled();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
});

test("PDF exposes native navigation and zoom controls", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-path$="/pages.pdf"]').click();
  await expect(page.locator('.editor-preview iframe[title="pages.pdf"]')).toBeVisible();
  await expect.poll(() => electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().flatMap((wc) => wc.mainFrame.framesInSubtree.map((f) => f.url)).join("\n"))).toContain("chrome-extension://");
  const inViewer = (script: string) => electronApp.evaluate(async ({ webContents }, code) => {
    const frame = webContents.getAllWebContents().flatMap((wc) => wc.mainFrame.framesInSubtree).find((f) => f.url.startsWith("chrome-extension://"))!;
    return frame.executeJavaScript(code);
  }, script);
  await expect.poll(() => inViewer(`!document.querySelector('pdf-viewer').shadowRoot.querySelector('#toolbar').hidden`)).toBe(true);
  const toolbar = `document.querySelector('pdf-viewer').shadowRoot.querySelector('#toolbar').shadowRoot`;
  const zoomInput = `${toolbar}.querySelector('input[aria-label="Zoom level"]')`;
  const zoomBefore = await inViewer(`${zoomInput}.value`);
  await inViewer(`${toolbar}.querySelector('[aria-label="Zoom in"]').click()`);
  await expect.poll(() => inViewer(`${zoomInput}.value`)).not.toBe(zoomBefore);
  await inViewer(`${toolbar}.querySelector('[aria-label="Zoom out"]').click()`);
  await expect.poll(() => inViewer(`${zoomInput}.value`)).toBe(zoomBefore);
  await inViewer(`${toolbar}.querySelector('#fit').click()`);
  const pageSelector = `${toolbar}.querySelector('viewer-page-selector').shadowRoot`;
  await expect.poll(() => inViewer(`${pageSelector}.querySelector('#pagelength').textContent.trim()`)).toBe("2");
  await inViewer(`(() => { const input = ${pageSelector}.querySelector('input'); input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await expect.poll(() => inViewer(`${pageSelector}.querySelector('input').value`)).toBe("2");
  // PDFium owns scrolling in this Electron version, not the outer DOM scroller.
  const scrollPosition = `document.querySelector('pdf-viewer').viewport.position.y`;
  await expect.poll(() => inViewer(scrollPosition)).toBeGreaterThan(0);
  const secondPagePosition = await inViewer(scrollPosition);
  if (typeof secondPagePosition !== "number") throw new Error("PDF viewport did not report a numeric scroll position");
  await inViewer(`(() => { const input = ${pageSelector}.querySelector('input'); input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await expect.poll(() => inViewer(scrollPosition)).toBeLessThan(secondPagePosition);
  expect(await inViewer("typeof window.termina")).toBe("undefined");
  expect(await inViewer(`document.querySelector('pdf-viewer').shadowRoot.querySelector('#plugin').getAttribute('javascript')`)).toBe("block");

  const src = await page.locator(".editor-preview iframe").getAttribute("src");
  const svgUrl = new URL(src!);
  svgUrl.searchParams.set("path", svgUrl.searchParams.get("path")!.replace("pages.pdf", "large.svg"));
  const blocked = await electronApp.evaluate(({ BrowserWindow }, url) => new Promise<boolean>((resolve) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    wc.once("will-frame-navigate", (event) => resolve(event.url === url && event.defaultPrevented));
    void wc.executeJavaScript(`document.querySelector('.editor-preview iframe').src = ${JSON.stringify(url)}`);
  }), svgUrl.href);
  expect(blocked).toBe(true);
});

test("PDF protocol refuses mismatched symlinks and paths outside the workspace", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const outside = join(runRoot, "outside.pdf");
  writeFileSync(outside, twoPagePdf());
  const response = (path: string) => electronApp.evaluate(async ({ net }, url) => {
    const result = await net.fetch(url);
    return { status: result.status, type: result.headers.get("content-type"), sniff: result.headers.get("x-content-type-options") };
  }, previewMediaUrl(path, 1));
  expect(await response(join(projectRoot, "pages.pdf"))).toEqual({ status: 200, type: "application/pdf", sniff: "nosniff" });
  expect((await response(join(projectRoot, "not-a-pdf.pdf"))).status).toBe(404);
  expect((await response(outside)).status).toBe(404);
});

test("image zoom stays anchored and respects its bounds", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="large.svg"]').click();
  const viewport = page.locator(".image-preview-viewport");
  const image = viewport.locator("img");
  const zoom = page.getByLabel("Image zoom", { exact: true });
  await page.getByRole("button", { name: "Actual size", exact: true }).click();
  await viewport.evaluate((el) => { el.scrollLeft = 300; el.scrollTop = 200; });
  const box = (await viewport.boundingBox())!;
  const point = { x: box.x + 150, y: box.y + 150 };
  const before = (await image.boundingBox())!;
  const relative = { x: (point.x - before.x) / before.width, y: (point.y - before.y) / before.height };
  await viewport.dispatchEvent("wheel", { deltaY: -10, ctrlKey: true, clientX: point.x, clientY: point.y });
  const after = (await image.boundingBox())!;
  expect(Math.abs(after.x + after.width * relative.x - point.x)).toBeLessThan(2);
  expect(Math.abs(after.y + after.height * relative.y - point.y)).toBeLessThan(2);
  for (let i = 0; i < 3; i++) await viewport.dispatchEvent("wheel", { deltaY: -300, ctrlKey: true });
  await expect(zoom).toHaveText("3200%");
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
  await viewport.press("+");
  await expect(zoom).toHaveText("3200%");
  for (let i = 0; i < 4; i++) await viewport.dispatchEvent("wheel", { deltaY: 300, ctrlKey: true });
  await expect(zoom).toHaveText("1%");
  await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled();
  await viewport.press("-");
  await expect(zoom).toHaveText("1%");
});

test("zero-size images report an error instead of loading forever", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-name="empty.svg"]').click();
  await expect(page.getByRole("status").filter({ hasText: "no viewable dimensions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
});

test("damaged images show an error with disabled zoom controls", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator('#explorer-tree .explorer-row[data-path$="/broken.png"]').click();
  await expect(page.getByRole("status").filter({ hasText: "This image could not be loaded" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
});
