const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  try {
    for (const { width, height, touch } of [
      { width: 390, height: 900, touch: true },
      { width: 844, height: 390, touch: true },
      { width: 1280, height: 900, touch: false },
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
      });
      await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8214/");
      await page
        .locator("[contenteditable=true]")
        .first()
        .waitFor({ timeout: 60000 });
      if (width < 768)
        await page.locator("[data-app-shell-sidebar-trigger]").first().click();
      assert.equal(
        await page.locator(".codex-web-directory-groups").count(),
        0,
      );
      const create = page.getByRole("button", {
        name: /^(添加新项目|Add new project)$/,
      });
      if (!touch) {
        // Move into the header first so Desktop reveals its hover-only controls.
        const box = await create.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      await create.click();
      await page
        .getByRole("button", { name: /^(下一步|Next)$/, exact: true })
        .click();
      const addSource = page.getByText(
        /^(添加 Codex 可读取和编辑的文件夹|Add folders Codex can read and edit)$/,
      );
      await addSource.click();
      const picker = page.locator(
        '[role=dialog][aria-labelledby="codex-web-workspace-root-dialog-title"]',
      );
      await picker.waitFor({ timeout: 20000 });
      const bounds = await picker.boundingBox();
      assert(
        bounds.y >= 0 && bounds.y + bounds.height <= height,
        "picker fits visible viewport",
      );
      assert.equal(
        await picker.getByRole("button", { name: /^Open folder / }).count(),
        0,
        "all inputs keep original folder rows without an Open action",
      );
      const pathInput = picker.getByRole("textbox", {
        name: "Selected folder path",
      });
      const folderRow = picker.locator("button[data-path]").first();
      await folderRow.waitFor();
      const folderPath = await folderRow.getAttribute("data-path");
      const initialEntries = await picker
        .locator("button[data-path]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-path")),
        );
      if (touch) await folderRow.tap();
      else await folderRow.click();
      assert.equal(
        await pathInput.inputValue(),
        folderPath,
        "single click selects folder",
      );
      assert.deepEqual(
        await picker
          .locator("button[data-path]")
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-path")),
          ),
        initialEntries,
        "single click preserves current directory listing",
      );
      // Exercise the existing double-click handler; do not add a touch gesture.
      await folderRow.dblclick();
      await page.waitForFunction((path) => {
        const root = document.querySelector("#codex-web-workspace-root-dialog");
        const submit = root?.querySelector("button[type=submit]");
        return (
          submit &&
          !submit.disabled &&
          !Array.from(root.querySelectorAll("button[data-path]")).some(
            (row) => row.dataset.path === path,
          )
        );
      }, folderPath);
      assert.equal(
        await pathInput.inputValue(),
        folderPath,
        "double click enters selected folder",
      );
      const selectBounds = await picker
        .getByRole("button", { name: "Select folder", exact: true })
        .boundingBox();
      assert(
        selectBounds.y >= 0 && selectBounds.y + selectBounds.height <= height,
        "confirmation stays visible",
      );
      await picker.getByRole("button", { name: "Cancel", exact: true }).click();
      await picker.waitFor({ state: "detached" });
      await addSource.click();
      await picker.waitFor();
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "detached" });
      await addSource.click();
      const select = picker.getByRole("button", {
        name: "Select folder",
        exact: true,
      });
      await select.waitFor();
      await page.waitForFunction(() => {
        const e = document.querySelector(
          "#codex-web-workspace-root-dialog button[type=submit]",
        );
        return e && !e.disabled;
      });
      const selectedPath = await picker
        .getByRole("textbox", { name: "Selected folder path" })
        .inputValue();
      assert(selectedPath.startsWith("/"));
      await select.click();
      await picker.waitFor({ state: "detached" });
      const folderName =
        selectedPath.split("/").filter(Boolean).at(-1) || selectedPath;
      const source = page
        .getByRole("dialog")
        .getByText(folderName, { exact: true });
      await source.waitFor();
      await source.hover();
      await page
        .getByRole("tooltip")
        .getByText(selectedPath, { exact: true })
        .waitFor();
      assert.equal(await addSource.count(), 0);
      // Stop before submitting the project: no persistent project is created.
      await page.close();
      console.log(
        `PASS ${width}px: native sidebar, picker cancel/Escape, source returned to project form`,
      );
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
