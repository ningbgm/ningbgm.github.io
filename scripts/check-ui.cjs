const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { mkdir, readFile } = require("node:fs/promises");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || join(tmpdir(), "ningbgm-ui-qa/node_modules/playwright"));

const previewUrl = process.env.PREVIEW_URL || "http://127.0.0.1:4173";
const output = resolve(process.env.UI_EVIDENCE_DIR || join(__dirname, "../.ui-review/screenshots"));
const visibleCases = ".comparison-case:not([hidden])";
const visibleCategories = ".example-category:not([hidden])";

async function assertSelectedCategory(page, id, focused = false) {
  const panel = page.locator(visibleCategories);
  const selectedTab = page.locator('#category-tabs [role="tab"][aria-selected="true"]');
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.getAttribute("id"), `example-${id}`);
  assert.equal(await panel.getAttribute("role"), "tabpanel");
  assert.equal(await panel.getAttribute("aria-labelledby"), `category-tab-${id}`);
  assert.equal(await selectedTab.count(), 1);
  assert.equal(await selectedTab.getAttribute("aria-controls"), `example-${id}`);
  assert.equal(await page.locator('#category-tabs [tabindex="0"]').count(), 1);
  assert.equal(await selectedTab.getAttribute("tabindex"), "0");
  assert.equal(await panel.locator(".examples-table tbody tr").count(), 4);
  assert.equal(await panel.locator(".output-cell").count(), 8);
  if (focused) assert.equal(await selectedTab.evaluate(node => node === document.activeElement), true);
}

async function selectCategory(page, id) {
  await page.locator(`#category-tab-${id}`).click();
  await assertSelectedCategory(page, id);
}

async function scrollTo(page, selector) {
  await page.locator(selector).evaluate((node) => node.scrollIntoView({ block: "start", behavior: "instant" }));
}

async function readyVideo(page, selector) {
  await page.locator(selector).first().waitFor();
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    return video && video.readyState >= 2 && video.videoWidth > 0;
  }, selector);
}

async function readyVisibleMedia(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.grid-video-wrap, .grid-image-wrap')].every((wrapper) => {
    const box = wrapper.getBoundingClientRect();
    if (!box.width || box.bottom <= 0 || box.top >= innerHeight) return true;
    const media = wrapper.querySelector('video, img');
    return media && (media.tagName === 'VIDEO' ? media.readyState >= 2 : media.complete && media.naturalWidth > 0);
  }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertLayout(page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflows at ${width}px`);
  const paragraphErrors = await page.locator(".abstract-copy, .source-inputs .grid-text-content, .disclaimer-copy p").evaluateAll(nodes =>
    nodes.flatMap(node => {
      const css = getComputedStyle(node);
      const expectedAlign = node.matches(".source-inputs .grid-text-content") ? "left" : "justify";
      return css.textAlign === expectedAlign && css.textAlignLast === "left" && css.hyphens === "auto"
        ? [] : [{ class: node.className, align: css.textAlign, expectedAlign, lastLine: css.textAlignLast, hyphens: css.hyphens }];
    })
  );
  assert.deepEqual(paragraphErrors, [], `Paragraph alignment differs at ${width}px`);
  const overflow = await page.locator(".table-scroll, .method-grid, .source-inputs, .category-tabs").evaluateAll((nodes) =>
    nodes.filter((node) => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 1)
      .map((node) => node.className)
  );
  assert.deepEqual(overflow, [], `Media area overflows at ${width}px`);
  const escapedMedia = await page.locator(".source-media").evaluateAll((nodes) =>
    nodes.filter((node) => {
      const child = node.firstElementChild;
      if (!child) return false;
      const outer = node.getBoundingClientRect();
      const inner = child.getBoundingClientRect();
      return inner.width && (inner.top < outer.top - 1 || inner.bottom > outer.bottom + 1 || inner.left < outer.left - 1 || inner.right > outer.right + 1);
    }).length
  );
  assert.equal(escapedMedia, 0, `Source media escapes its row at ${width}px`);
  const ratioErrors = await page.locator(".grid-video-wrap video, .grid-image-wrap img").evaluateAll((media) =>
    media.flatMap((node) => {
      const box = node.parentElement.getBoundingClientRect();
      const naturalWidth = node.videoWidth || node.naturalWidth;
      const naturalHeight = node.videoHeight || node.naturalHeight;
      if (!box.width || !box.height || !naturalWidth || !naturalHeight) return [];
      const expected = naturalWidth / naturalHeight;
      const actual = box.width / box.height;
      return Math.abs(actual / expected - 1) > 0.02
        ? [{ label: node.getAttribute("aria-label") || node.alt, actual, expected }]
        : [];
    })
  );
  assert.deepEqual(ratioErrors, [], `Player frame does not match native media ratio at ${width}px`);
}

(async () => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`);
    });
    await page.goto(previewUrl, { waitUntil: "networkidle" });
    assert.equal(await page.title(), "NingBGM | Anonymous Review Demo");
    assert.equal(await page.locator("#abstractToggle").isVisible(), false);
    assert.equal(await page.locator("#abstractText").evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true);
    await assertLayout(page, 1440);
    await readyVisibleMedia(page);
    await page.screenshot({ path: join(output, "desktop-overview.png") });
    await scrollTo(page, "#TB");
    await readyVideo(page, "#comparison-case-1 video");
    assert.equal(await page.locator(visibleCases).count(), 1);
    assert.equal(await page.locator(`${visibleCases} .method-result`).count(), 8);
    await page.getByRole("tab", { name: "Case 3" }).click();
    assert.equal(await page.locator(visibleCases).getAttribute("data-case"), "3");
    await page.getByRole("tab", { name: "Case 3" }).press("ArrowRight");
    assert.equal(await page.locator(visibleCases).getAttribute("data-case"), "4");
    await page.getByRole("tab", { name: "Case 4" }).press("Home");
    assert.equal(await page.locator(visibleCases).getAttribute("data-case"), "1");

    const first = page.locator("#comparison-case-1 video").nth(0);
    const second = page.locator("#comparison-case-1 video").nth(1);
    await first.evaluate(async (video) => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector("#comparison-case-1 video").currentTime > 0.1);
    await second.evaluate(async (video) => { video.muted = true; await video.play(); });
    assert.equal(await first.evaluate((video) => video.paused), true);
    await page.getByRole("tab", { name: "Case 2" }).click();
    assert.equal(await second.evaluate((video) => video.paused), true);
    await page.getByRole("tab", { name: "Case 1" }).click();
    await scrollTo(page, "#TB");
    await page.waitForFunction(() => [...document.querySelectorAll("#comparison-case-1 video")].length === 8 &&
      [...document.querySelectorAll("#comparison-case-1 video")].every((video) => video.readyState >= 2));
    await page.screenshot({ path: join(output, "desktop-comparison.png") });

    await page.locator("#allCases").check();
    assert.equal(await page.locator(visibleCases).count(), 5);
    assert.equal(await page.locator(`${visibleCases} .method-result`).count(), 40);
    for (let id = 1; id <= 5; id++) {
      await scrollTo(page, `#comparison-case-${id}`);
      await readyVideo(page, `#comparison-case-${id} video`);
      await page.locator(`#comparison-case-${id} .method-result`).last().scrollIntoViewIfNeeded();
      await page.waitForFunction((id) => document.querySelectorAll(`#comparison-case-${id} video`).length === 8, id);
    }
    const comparePaths = await page.locator("#comparison-results video").evaluateAll((videos) => videos.map((video) => new URL(video.src).pathname));
    assert.equal(new Set(comparePaths).size, 40);
    await page.locator("#allCases").uncheck();
    await scrollTo(page, "#Examples");
    await page.locator("#example-live").waitFor({ state: "attached" });
    assert.equal(await page.locator(".example-category").count(), 10);
    assert.equal(await page.locator(".examples-table tbody tr").count(), 40);
    assert.equal(await page.getByRole("tablist", { name: "Scene categories" }).getByRole("tab").count(), 10);
    assert.equal(await page.locator(".source-inputs .source-input").count(), 40);
    await assertSelectedCategory(page, "beauty");
    await page.locator("#category-tab-beauty").press("ArrowLeft");
    await assertSelectedCategory(page, "live", true);
    await page.locator("#category-tab-live").press("ArrowRight");
    await assertSelectedCategory(page, "beauty", true);
    await page.locator("#category-tab-beauty").press("End");
    await assertSelectedCategory(page, "live", true);
    await page.locator("#category-tab-live").press("Home");
    await assertSelectedCategory(page, "beauty", true);

    await scrollTo(page, "#category-tabs");
    const scrollBefore = await page.evaluate(() => scrollY);
    const historyBefore = await page.evaluate(() => history.length);
    await selectCategory(page, "technology");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => location.hash), "#example-technology");
    assert.equal(await page.evaluate(() => history.length), historyBefore);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 2, "Category click scrolls the page");

    const manifest = JSON.parse(await readFile(join(__dirname, "../web/data/example_mp4.json"), "utf8"));
    for (const category of manifest.categories) {
      const selector = `#example-${category.id}`;
      await selectCategory(page, category.id);
      await scrollTo(page, selector);
      await readyVideo(page, `${selector} .source-inputs video`);
      await page.locator(`${selector} .examples-table tr`).last().scrollIntoViewIfNeeded();
      await page.waitForFunction((selector) => document.querySelectorAll(`${selector} .output-cell video`).length === 8, selector);
      const paths = await page.locator(`${selector} .output-cell video`).evaluateAll((videos) => videos.map((video) => decodeURI(new URL(video.src).pathname).slice(1)).sort());
      assert.deepEqual(paths, category.rows.flatMap((row) => [row.output.bgm, row.output.vocal]).sort(), `Changed outputs: ${category.id}`);
      assert.equal(await page.locator(`${selector} .grid-text-content`).textContent(), category.original.text);
      await assertLayout(page, 1440);
    }
    await scrollTo(page, "#Examples");
    await selectCategory(page, "technology");
    await readyVideo(page, "#example-technology video");
    await assertLayout(page, 1440);
    await readyVisibleMedia(page);
    await page.screenshot({ path: join(output, "desktop-examples.png") });
    await selectCategory(page, "beauty");
    await scrollTo(page, "#Examples");
    await readyVideo(page, "#example-beauty video");
    await readyVisibleMedia(page);
    await page.screenshot({ path: join(output, "desktop-portrait.png") });
    assert.equal(await page.locator('a[href^="#"]').evaluateAll((nodes) =>
      nodes.every((node) => document.getElementById(node.getAttribute("href").slice(1)))), true);

    const inputAudio = page.locator("#example-beauty audio");
    await inputAudio.evaluate(async (audio) => { audio.muted = true; await audio.play(); });
    await selectCategory(page, "technology");
    assert.equal(await inputAudio.evaluate(audio => audio.paused), true, "Hidden category audio keeps playing");
    await selectCategory(page, "beauty");
    await inputAudio.evaluate(async audio => { await audio.play(); });
    const outputVideo = page.locator("#example-beauty .output-cell video").first();
    await outputVideo.evaluate(async (video) => { video.muted = true; await video.play(); });
    assert.equal(await inputAudio.evaluate((audio) => audio.paused), true);
    await selectCategory(page, "technology");
    assert.equal(await outputVideo.evaluate(video => video.paused), true, "Hidden category video keeps playing");
    await selectCategory(page, "beauty");
    assert.equal(await outputVideo.evaluate(video => video.paused), true, "Returning to a category auto-plays media");

    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
      await page.goto(previewUrl, { waitUntil: "networkidle" });
      await assertLayout(page, width);
      if (width <= 640) {
        assert.equal(await page.locator("#abstractToggle").getAttribute("aria-expanded"), "false");
        await page.locator("#abstractToggle").click();
        assert.equal(await page.locator("#abstractToggle").getAttribute("aria-expanded"), "true");
        await assertLayout(page, width);
        await page.screenshot({ path: join(output, `abstract-expanded-${width}.png`) });
        await page.locator("#abstractToggle").click();
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      }
      await readyVisibleMedia(page);
      await page.screenshot({ path: join(output, `overview-${width}.png`) });
      await scrollTo(page, "#TB");
      await readyVideo(page, "#comparison-case-1 video");
      await assertLayout(page, width);
      await readyVisibleMedia(page);
      await page.screenshot({ path: join(output, `comparison-${width}.png`) });
      await scrollTo(page, "#Examples");
      await page.locator("#example-live").waitFor({ state: "attached" });
      await selectCategory(page, "technology");
      await scrollTo(page, "#Examples");
      await readyVideo(page, "#example-technology video");
      await page.waitForFunction(() => [...document.querySelectorAll("#example-technology img")].every((img) => img.complete && img.naturalWidth > 0));
      await assertLayout(page, width);
      await readyVisibleMedia(page);
      await page.screenshot({ path: join(output, `examples-${width}.png`) });
      await selectCategory(page, "beauty");
      await scrollTo(page, "#Examples");
      await readyVideo(page, "#example-beauty video");
      await readyVisibleMedia(page);
      await assertLayout(page, width);
      await page.screenshot({ path: join(output, `portrait-${width}.png`) });
      await scrollTo(page, "#example-beauty .source-inputs");
      await readyVisibleMedia(page);
      await page.locator("#example-beauty .source-inputs").screenshot({ path: join(output, `inputs-${width}.png`) });
      await scrollTo(page, "#Disclaimer");
      await readyVisibleMedia(page);
      await page.screenshot({ path: join(output, `notes-${width}.png`) });
    }
    assert.deepEqual(errors, []);

    for (const width of [640, 760, 768, 900, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await assertLayout(page, width);
    }

    const deepLinkPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    deepLinkPage.on("pageerror", error => errors.push(error.message));
    await deepLinkPage.goto(new URL("#example-technology", previewUrl).href);
    await deepLinkPage.locator("#category-tabs").waitFor();
    await assertSelectedCategory(deepLinkPage, "technology");
    await deepLinkPage.waitForFunction(() => Math.abs(document.getElementById("category-tabs").getBoundingClientRect().top - 28) < 3);
    await readyVideo(deepLinkPage, "#example-technology video");
    await deepLinkPage.evaluate(() => { location.hash = "#example-sport"; });
    await deepLinkPage.waitForFunction(() => !document.getElementById("example-sport").hidden);
    await assertSelectedCategory(deepLinkPage, "sport");
    await deepLinkPage.evaluate(() => { location.hash = "#example-missing"; });
    await deepLinkPage.waitForFunction(() => !document.getElementById("example-beauty").hidden);
    await assertSelectedCategory(deepLinkPage, "beauty");
    await deepLinkPage.goto(new URL("#example-missing", previewUrl).href);
    await deepLinkPage.locator("#category-tabs").waitFor();
    await assertSelectedCategory(deepLinkPage, "beauty");
    await deepLinkPage.setViewportSize({ width: 1440, height: 500 });
    await deepLinkPage.goto(previewUrl, { waitUntil: "networkidle" });
    assert.equal(await deepLinkPage.locator(".example-category").count(), 0, "Gallery should remain deferred above the fold");
    await deepLinkPage.evaluate(() => { location.hash = "#example-food"; });
    await deepLinkPage.locator("#category-tabs").waitFor();
    await assertSelectedCategory(deepLinkPage, "food");
    await deepLinkPage.close();

    const retryPage = await browser.newPage();
    let failed = false;
    await retryPage.route("**/web/data/example_mp4.json", async (route) => {
      if (!failed) { failed = true; await route.fulfill({ status: 503, body: "Unavailable" }); }
      else await route.continue();
    });
    await retryPage.goto(new URL("#example-technology", previewUrl).href);
    await retryPage.getByRole("button", { name: "Retry", exact: true }).click();
    await retryPage.locator("#example-live").waitFor({ state: "attached" });
    assert.equal(await retryPage.locator(".example-category").count(), 10);
    await assertSelectedCategory(retryPage, "technology");
    await retryPage.close();
    assert.deepEqual(errors, []);
    console.log("PASS: 1440/1024/390/320 layouts, left-aligned source text and justified prose, five cases/eight methods, ten category tabs and keyboard selection, no-scroll switching, playback advancement/exclusivity, all 80 category outputs, source text, deep links, invalid categories and retry.");
    console.log(`Screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
