const assert = require("node:assert/strict");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { mkdir, readFile } = require("node:fs/promises");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || join(tmpdir(), "ningbgm-ui-qa/node_modules/playwright"));

const previewUrl = process.env.PREVIEW_URL || "http://127.0.0.1:4173";
const output = resolve(process.env.UI_EVIDENCE_DIR || join(__dirname, "../.ui-review/screenshots"));
const visibleCases = ".comparison-case:not([hidden])";

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
  const overflow = await page.locator(".table-scroll, .method-grid, .source-inputs").evaluateAll((nodes) =>
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
    assert.equal(await page.locator(".category-nav a").count(), 10);
    assert.equal(await page.locator(".source-inputs .source-input").count(), 40);
    const manifest = JSON.parse(await readFile(join(__dirname, "../web/data/example_mp4.json"), "utf8"));
    for (const category of manifest.categories) {
      const selector = `#example-${category.id}`;
      await scrollTo(page, selector);
      await readyVideo(page, `${selector} .source-inputs video`);
      await page.locator(`${selector} .examples-table tr`).last().scrollIntoViewIfNeeded();
      await page.waitForFunction((selector) => document.querySelectorAll(`${selector} .output-cell video`).length === 8, selector);
      const paths = await page.locator(`${selector} .output-cell video`).evaluateAll((videos) => videos.map((video) => decodeURI(new URL(video.src).pathname).slice(1)).sort());
      assert.deepEqual(paths, category.rows.flatMap((row) => [row.output.bgm, row.output.vocal]).sort(), `Changed outputs: ${category.id}`);
      assert.equal(await page.locator(`${selector} .grid-text-content`).textContent(), category.original.text);
    }
    await scrollTo(page, "#Examples");
    await page.getByRole("link", { name: "Technology", exact: true }).click();
    await page.waitForFunction(() => location.hash === "#example-technology" &&
      Math.abs(document.getElementById("example-technology").getBoundingClientRect().top - 28) < 3);
    await readyVideo(page, "#example-technology video");
    await assertLayout(page, 1440);
    await readyVisibleMedia(page);
    await page.screenshot({ path: join(output, "desktop-examples.png") });
    await scrollTo(page, "#example-beauty");
    await readyVideo(page, "#example-beauty video");
    await readyVisibleMedia(page);
    await page.screenshot({ path: join(output, "desktop-portrait.png") });
    assert.equal(await page.locator('a[href^="#"]').evaluateAll((nodes) =>
      nodes.every((node) => document.getElementById(node.getAttribute("href").slice(1)))), true);

    const inputAudio = page.locator("#example-beauty audio");
    await inputAudio.evaluate(async (audio) => { audio.muted = true; await audio.play(); });
    const outputVideo = page.locator("#example-beauty .output-cell video").first();
    await outputVideo.evaluate(async (video) => { video.muted = true; await video.play(); });
    assert.equal(await inputAudio.evaluate((audio) => audio.paused), true);
    await outputVideo.evaluate((video) => video.pause());

    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
      await page.goto(previewUrl, { waitUntil: "networkidle" });
      await assertLayout(page, width);
      if (width <= 640) {
        assert.equal(await page.locator("#abstractToggle").getAttribute("aria-expanded"), "false");
        await page.locator("#abstractToggle").click();
        assert.equal(await page.locator("#abstractToggle").getAttribute("aria-expanded"), "true");
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
      await scrollTo(page, "#example-technology");
      await readyVideo(page, "#example-technology video");
      await page.waitForFunction(() => [...document.querySelectorAll("#example-technology img")].every((img) => img.complete && img.naturalWidth > 0));
      await assertLayout(page, width);
      await readyVisibleMedia(page);
      await page.screenshot({ path: join(output, `examples-${width}.png`) });
      await scrollTo(page, "#example-beauty");
      await readyVideo(page, "#example-beauty video");
      await readyVisibleMedia(page);
      await assertLayout(page, width);
      await page.screenshot({ path: join(output, `portrait-${width}.png`) });
    }
    assert.deepEqual(errors, []);

    for (const width of [640, 760, 768, 900, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await assertLayout(page, width);
    }

    const retryPage = await browser.newPage();
    let failed = false;
    await retryPage.route("**/web/data/example_mp4.json", async (route) => {
      if (!failed) { failed = true; await route.fulfill({ status: 503, body: "Unavailable" }); }
      else await route.continue();
    });
    await retryPage.goto(previewUrl);
    await scrollTo(retryPage, "#Examples");
    await retryPage.getByRole("button", { name: "Retry", exact: true }).click();
    await retryPage.locator("#example-live").waitFor({ state: "attached" });
    assert.equal(await retryPage.locator(".example-category").count(), 10);
    await retryPage.close();
    console.log("PASS: 1440/1024/390/320 layouts, abstract, five cases/eight methods, keyboard selection, playback advancement/exclusivity, all 80 category outputs, source text, anchors and retry.");
    console.log(`Screenshots: ${output}`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
