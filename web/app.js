const EXAMPLE_MP4_URL = new URL("./data/example_mp4.json", import.meta.url).href;

const ROW_CASES = ["1", "2", "3", "4", "5"];
// Measured source proportions reserve space before lazy videos load.
const CASE_ASPECT_RATIOS = { "1": 3 / 4, "2": 1, "3": 3 / 4, "4": 3 / 4, "5": 3 / 4 };
const COL_MODELS = [
  "GroundTruth",
  "Ours",
  "CMT",
  "Diff_bgm",
  "GVMGen",
  "M2UGen",
  "VeM",
  "VidMuse",
];
const MODEL_LABELS = {
  GroundTruth: "Ground truth",
  Ours: "NingBGM (Ours)",
  Diff_bgm: "Diff-BGM",
  M2UGen: "M2UGen",
};
const SPECIAL_FILE_MAP = {
  Ours: {
    "1": "1_bgm.mp4",
    "2": "2_bgm_2.mp4",
    "3": "3_bgm_2.mp4",
    "4": "4_bgm.mp4",
    "5": "5_bgm.mp4",
  },
};
const ROW_ORDER = [
  "video_audio_image_text",
  "video_image_text",
  "audio_image_text",
  "image_text",
];
const CONDITION_LABELS = {
  video_audio_image_text: { title: "All modalities", modalities: ["Video", "Audio", "Image", "Text"] },
  video_image_text: { title: "Without audio", modalities: ["Video", "Image", "Text"] },
  audio_image_text: { title: "Without video", modalities: ["Audio", "Image", "Text"] },
  image_text: { title: "Image and text", modalities: ["Image", "Text"] },
};
const EXAMPLES_BATCH_SIZE = 10;
const MAX_CONCURRENT_PREFETCH = 2;

const PLACEHOLDER_LABELS = {
  video: "No video modality",
  image: "No image modality",
  audio: "No audio modality",
};

const allVideos = [];
const allAudios = [];
const videoPrefetchQueue = [];
const loadedVideoUrls = new Set();
const lazyVideoLoaders = new WeakMap();
const exampleRenderState = {
  triggerObserver: null,
  batchObserver: null,
  sentinel: null,
  nextBatchQueued: false,
  loading: false,
  loaded: false,
  generation: 0,
};

let activePrefetchCount = 0;
let sharedVideoObserver;
let resizeTimer;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }

  const normalizedChildren = Array.isArray(children) ? children : [children];
  normalizedChildren.forEach((child) => {
    if (child === undefined || child === null) return;
    node.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child
    );
  });

  return node;
}

function setStatus(message) {
  const status = document.getElementById("status");
  if (status) status.textContent = message || "";
}

function resolveMediaSrc(src) {
  if (!src) return "";
  try {
    const base =
      typeof document !== "undefined" && document.baseURI ? document.baseURI : "";
    const normalized = base.replace(/\/$/, "");
    const baseForDemo = normalized.endsWith("/web")
      ? new URL("../", base)
      : new URL(base);
    return new URL(src, baseForDemo.href).href;
  } catch {
    return src;
  }
}

function scheduleLowPriorityWork(task) {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(task, { timeout: 400 });
    return;
  }
  window.setTimeout(task, 16);
}

function disconnectExampleObservers() {
  if (exampleRenderState.triggerObserver) {
    exampleRenderState.triggerObserver.disconnect();
    exampleRenderState.triggerObserver = null;
  }
  if (exampleRenderState.batchObserver) {
    exampleRenderState.batchObserver.disconnect();
    exampleRenderState.batchObserver = null;
  }
  if (exampleRenderState.sentinel) {
    exampleRenderState.sentinel.remove();
    exampleRenderState.sentinel = null;
  }
  exampleRenderState.nextBatchQueued = false;
}

function resetRuntimeState() {
  exampleRenderState.generation += 1;
  allVideos.splice(0).forEach((video) => video.pause());
  allAudios.splice(0).forEach((audio) => audio.pause());
  if (sharedVideoObserver) {
    sharedVideoObserver.disconnect();
    sharedVideoObserver = null;
  }
  videoPrefetchQueue.length = 0;
  loadedVideoUrls.clear();
  activePrefetchCount = 0;
  disconnectExampleObservers();
  exampleRenderState.loading = false;
  exampleRenderState.loaded = false;
  setStatus("");
}

function getCompareBasePath() {
  const base =
    typeof document !== "undefined" && document.baseURI ? document.baseURI : "";
  const normalized = base.replace(/\/$/, "");
  return normalized.endsWith("/web")
    ? "../demo_io/demo_compare"
    : "demo_io/demo_compare";
}

function getCompareVideoPath(model, caseId) {
  const base = getCompareBasePath();
  if (SPECIAL_FILE_MAP[model]?.[caseId]) {
    return `${base}/${model}/${caseId}/${SPECIAL_FILE_MAP[model][caseId]}`;
  }
  return `${base}/${model}/${caseId}/${caseId}.mp4`;
}

function enqueueVideoPrefetch(src) {
  const resolved = resolveMediaSrc(src);
  if (!resolved || loadedVideoUrls.has(resolved)) return;
  const existingIndex = videoPrefetchQueue.indexOf(resolved);
  if (existingIndex !== -1) videoPrefetchQueue.splice(existingIndex, 1);
  videoPrefetchQueue.unshift(resolved);
  processPrefetchQueue();
}

function processPrefetchQueue() {
  while (
    videoPrefetchQueue.length > 0 &&
    activePrefetchCount < MAX_CONCURRENT_PREFETCH
  ) {
    const src = videoPrefetchQueue.shift();
    if (!src || loadedVideoUrls.has(src)) continue;
    activePrefetchCount += 1;
    prefetchSingleVideo(src);
  }
}

function prefetchSingleVideo(src) {
  const prefetchVideo = el("video", {
    src,
    preload: "metadata",
    muted: "",
  });

  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (!loadedVideoUrls.has(src)) loadedVideoUrls.add(src);
    prefetchVideo.src = "";
    prefetchVideo.remove();
    activePrefetchCount = Math.max(0, activePrefetchCount - 1);
    processPrefetchQueue();
  };

  prefetchVideo.addEventListener("loadedmetadata", cleanup, { once: true });
  prefetchVideo.addEventListener("canplaythrough", cleanup, { once: true });
  prefetchVideo.addEventListener("error", cleanup, { once: true });
  window.setTimeout(cleanup, 10000);
}

function enqueueAllVideosInOrder() {
  const containers = document.querySelectorAll(".table-scroll, #videoGallery");
  containers.forEach((container) => {
    container.querySelectorAll(".grid-video-wrap video").forEach((video) => {
      const resolved = video.currentSrc || video.src;
      if (
        resolved &&
        !loadedVideoUrls.has(resolved) &&
        !videoPrefetchQueue.includes(resolved)
      ) {
        videoPrefetchQueue.push(resolved);
      }
    });
  });
  processPrefetchQueue();
}

function getSharedVideoObserver() {
  if (sharedVideoObserver) return sharedVideoObserver;
  sharedVideoObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const loader = lazyVideoLoaders.get(entry.target);
        if (!loader) return;
        lazyVideoLoaders.delete(entry.target);
        observer.unobserve(entry.target);
        loader();
      });
    },
    { threshold: 0.05, rootMargin: "160px" }
  );
  return sharedVideoObserver;
}

function createVideoElement(src, poster) {
  return el("video", {
    src: resolveMediaSrc(src),
    poster: poster ? resolveMediaSrc(poster) : undefined,
    preload: "metadata",
    playsinline: "",
    "webkit-playsinline": "",
    controls: "",
    loop: "",
  });
}

function pauseOtherMedia(activeMedia) {
  allVideos.forEach((item) => {
    if (item !== activeMedia && !item.paused) item.pause();
  });
  allAudios.forEach((item) => {
    if (item !== activeMedia && !item.paused) item.pause();
  });
}

function setupVideoEvents(video, wrapper, src) {
  const updateState = () => {
    wrapper.classList.toggle("is-playing", !video.paused);
  };

  updateState();
  video.addEventListener("play", () => {
    pauseOtherMedia(video);
    if (video.readyState < 2) video.preload = "auto";
    enqueueVideoPrefetch(src);
    updateState();
  });
  video.addEventListener("pause", updateState);
  video.addEventListener("ended", updateState);
}

function createLoadingIndicator(label = "media") {
  return el("div", {
    class: "loading-indicator",
    text: `Loading ${label}...`,
  });
}

function mediaNode(src, label, isSimple = false, options = {}) {
  const wrapper = el("div", {
    class: "grid-video-wrap lazy-video",
    "aria-busy": "true",
  });
  const loadingIndicator = createLoadingIndicator("video");

  wrapper.appendChild(loadingIndicator);
  wrapper.title = label;

  wrapper.style.setProperty("--media-ratio", String(options.aspectRatio || 16 / 9));

  const mountVideo = () => {
    if (wrapper.querySelector("video")) return;

    const resolved = resolveMediaSrc(src);
    const video = createVideoElement(src, options.poster);
    video.setAttribute("aria-label", label);
    let loadingSettled = false;
    let errorShown = false;
    let timeoutId;

    const finishLoading = () => {
      if (loadingSettled) return;
      loadingSettled = true;
      window.clearTimeout(timeoutId);
      if (wrapper.contains(loadingIndicator)) loadingIndicator.remove();
      wrapper.classList.add("loaded");
      wrapper.setAttribute("aria-busy", "false");
    };
    const showError = () => {
      if (errorShown) return;
      errorShown = true;
      finishLoading();
      video.hidden = true;
      wrapper.classList.add("has-error");
      wrapper.appendChild(
        el("p", {
          class: "media-error",
          text: `Unable to load ${label}.`,
        })
      );
    };

    wrapper.insertBefore(video, loadingIndicator);
    video.addEventListener("loadedmetadata", finishLoading, { once: true });
    video.addEventListener("canplay", finishLoading, { once: true });
    video.addEventListener("error", showError, { once: true });
    timeoutId = window.setTimeout(finishLoading, 15000);

    allVideos.push(video);
    loadedVideoUrls.add(resolved);

    video.addEventListener("loadedmetadata", () => {
      if (video.videoWidth && video.videoHeight) {
        wrapper.style.setProperty("--media-ratio", String(video.videoWidth / video.videoHeight));
      }
    }, { once: true });

    setupVideoEvents(video, wrapper, src);
  };

  lazyVideoLoaders.set(wrapper, mountVideo);
  if (typeof window !== "undefined" && "IntersectionObserver" in window) {
    getSharedVideoObserver().observe(wrapper);
  } else {
    scheduleLowPriorityWork(mountVideo);
  }

  if (isSimple) return wrapper;

  return el("div", { class: "grid-card" }, [
    wrapper,
    el("div", { class: "grid-label", text: label }),
  ]);
}

function renderCompareMatrix(container) {
  container.innerHTML = "";
  container.appendChild(
    el("div", { class: "section-head" }, [
      el("h2", { class: "page-title", text: "Video-to-Music Generation" }),
      el("p", { class: "page-subtitle", text: "Comparison with other methods" }),
    ])
  );

  const results = el("div", { id: "comparison-results" });
  ROW_CASES.forEach((caseId) => {
    const panel = el("section", {
      class: "comparison-case", id: `comparison-case-${caseId}`,
      "data-case": caseId, role: "tabpanel",
      "aria-labelledby": `case-tab-${caseId}`, tabindex: "0",
    });
    panel.hidden = caseId !== ROW_CASES[0];
    const title = el("h3", { class: "case-title", text: `Case ${caseId}` });
    title.hidden = true;
    panel.appendChild(title);
    panel.appendChild(el("div", { class: "method-grid" }, COL_MODELS.map((model) => {
      const label = MODEL_LABELS[model] || model;
      return el("figure", {
        class: `method-result compare-cell${model === "Ours" ? " method-ours" : ""}`,
        "data-model": model,
      }, [
        el("figcaption", { text: label }),
        mediaNode(getCompareVideoPath(model, caseId), `Case ${caseId}: ${label}`, true, {
          poster: `web/posters/case-${caseId}.jpg`,
          aspectRatio: CASE_ASPECT_RATIOS[caseId],
        }),
      ]);
    })));
    results.appendChild(panel);
  });

  let selectedCase = ROW_CASES[0];
  const tabs = el("div", { class: "case-tabs", role: "tablist", "aria-label": "Comparison case" });
  const allCases = el("input", { type: "checkbox", id: "allCases" });
  const updateCases = () => {
    pauseOtherMedia(null);
    results.querySelectorAll(".comparison-case").forEach((panel) => {
      panel.hidden = !allCases.checked && panel.dataset.case !== selectedCase;
      panel.querySelector(".case-title").hidden = !allCases.checked;
      panel.setAttribute("role", allCases.checked ? "region" : "tabpanel");
      panel.setAttribute("aria-label", `Case ${panel.dataset.case}`);
      if (allCases.checked) panel.removeAttribute("aria-labelledby");
      else panel.setAttribute("aria-labelledby", `case-tab-${panel.dataset.case}`);
    });
    tabs.hidden = allCases.checked;
    tabs.querySelectorAll("button").forEach((button) => {
      const selected = button.dataset.case === selectedCase;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    window.requestAnimationFrame(syncCompareCellSizeToCssVars);
  };
  ROW_CASES.forEach((caseId, index) => {
    tabs.appendChild(el("button", {
      type: "button", role: "tab", text: `Case ${caseId}`, "data-case": caseId,
      id: `case-tab-${caseId}`,
      "aria-selected": String(index === 0),
      "aria-controls": `comparison-case-${caseId}`,
      tabindex: index === 0 ? "0" : "-1",
      onclick: () => { selectedCase = caseId; updateCases(); },
      onkeydown: (event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % ROW_CASES.length;
        else if (event.key === "ArrowLeft") next = (index + ROW_CASES.length - 1) % ROW_CASES.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = ROW_CASES.length - 1;
        else return;
        event.preventDefault();
        selectedCase = ROW_CASES[next];
        updateCases();
        tabs.children[next].focus();
      },
    }));
  });
  allCases.addEventListener("change", updateCases);
  container.appendChild(el("div", { class: "comparison-controls" }, [
    tabs, el("label", { class: "view-toggle", for: "allCases" }, [allCases, "All cases"]),
  ]));
  container.appendChild(results);
  window.requestAnimationFrame(syncCompareCellSizeToCssVars);
}

function syncCompareCellSizeToCssVars() {
  const firstWrap = document.querySelector("#tbCompare .compare-cell .grid-video-wrap");
  if (!firstWrap) return;

  const { width, height } = firstWrap.getBoundingClientRect();
  if (!width || !height) return;

  const area = width * height;
  const root = document.documentElement;

  root.style.setProperty("--compare-cell-width", `${width}px`);
  root.style.setProperty("--compare-cell-height", `${height}px`);
  root.style.setProperty("--example-cell-area", String(area));
  root.style.setProperty(
    "--example-portrait-width",
    `${Math.sqrt((area * 9) / 16)}px`
  );
  root.style.setProperty(
    "--example-portrait-height",
    `${Math.sqrt((area * 16) / 9)}px`
  );
  root.style.setProperty(
    "--example-landscape-width",
    `${Math.sqrt((area * 16) / 9)}px`
  );
  root.style.setProperty(
    "--example-landscape-height",
    `${Math.sqrt((area * 9) / 16)}px`
  );
}

window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(syncCompareCellSizeToCssVars, 250);
});

function imageNode(src, label, options = {}) {
  const img = el("img", {
    src: resolveMediaSrc(src),
    alt: label || "",
    loading: "lazy",
    decoding: "async",
  });
  const wrapper = el("div", { class: "grid-image-wrap" }, [img]);
  wrapper.title = label;
  wrapper.style.setProperty("--media-ratio", String(options.aspectRatio || 16 / 9));
  img.addEventListener("load", () => {
    if (img.naturalWidth && img.naturalHeight) {
      wrapper.style.setProperty("--media-ratio", String(img.naturalWidth / img.naturalHeight));
    }
  });

  return wrapper;
}

function audioNode(src, label) {
  const audio = el("audio", {
    src: resolveMediaSrc(src),
    preload: "metadata",
    controls: "",
    "aria-label": label,
  });
  const wrapper = el("div", { class: "grid-audio-wrap" }, [audio]);
  wrapper.title = label;

  allAudios.push(audio);
  audio.addEventListener("play", () => {
    pauseOtherMedia(audio);
    if (audio.readyState < 2) audio.preload = "auto";
  });
  audio.addEventListener(
    "error",
    () => {
      audio.hidden = true;
      wrapper.appendChild(
        el("p", {
          class: "media-error media-error-light",
          text: `Unable to load ${label}.`,
        })
      );
    },
    { once: true }
  );

  return wrapper;
}

function textNode(text) {
  return el("div", { class: "grid-text-wrap" }, [
    el("div", { class: "grid-text-content", text: text || "" }),
  ]);
}

function placeholderNode(modality) {
  return el("div", { class: "ex-placeholder ex-placeholder-missing-modality" }, [
    el("span", {
      class: "ex-placeholder-text",
      text: PLACEHOLDER_LABELS[modality] || "Not included",
    }),
  ]);
}

function renderExampleRow(rowData, categoryName, index, mediaOptions) {
  const condition = rowData.label || rowData.type;
  const label = CONDITION_LABELS[rowData.type];
  const row = el("tr", { "data-condition": rowData.type });
  row.appendChild(el("th", { class: "condition-label", scope: "row" }, [
    el("span", { class: "condition-heading" }, [
      el("span", { class: "condition-number", text: `0${index + 1}` }),
      el("span", { class: "condition-title", text: label?.title || condition }),
    ]),
    el("span", { class: "condition-name" }, label ? label.modalities.map((modality, index) =>
      el("span", { class: "condition-term" }, [
        index ? el("span", { class: "condition-join", text: "+ " }) : null,
        el("abbr", { text: modality[0], title: modality }),
      ])
    ) : []),
  ]));
  for (const [key, label] of [["bgm", "Ours (BGM)"], ["vocal", "Ours (Vocal)"]]) {
    row.appendChild(el("td", { class: "example-media-cell output-cell", "data-label": label }, [
      rowData.output?.[key]
        ? mediaNode(rowData.output[key], `${categoryName}: ${condition}, ${label}`, true, mediaOptions)
        : placeholderNode("video"),
    ]));
  }
  return row;
}

function renderCategory(category) {
  const original = category.original || {};
  const categoryName = category.name || "Category";
  const mediaOptions = {
    poster: original.image,
    aspectRatio: category.orientation === "portrait" ? 9 / 16 : 16 / 9,
  };
  const section = el("section", {
    class: `example-category ${category.orientation || "landscape"}`,
    id: `example-${category.id || "category"}`,
    "aria-labelledby": `category-title-${category.id}`,
  });
  section.appendChild(
    el("h3", { class: "category-title", id: `category-title-${category.id}`, text: categoryName })
  );
  section.appendChild(el("p", { class: "category-subtitle", text: "Multimodal input conditions" }));
  const inputs = [
    ["Input video", original.video ? mediaNode(original.video, `${categoryName}: Input video`, true, mediaOptions) : placeholderNode("video")],
    ["Input image", original.image ? imageNode(original.image, `${categoryName}: Input image`, mediaOptions) : placeholderNode("image")],
    ["Input audio", original.audio ? audioNode(original.audio, `${categoryName}: Input audio`) : placeholderNode("audio")],
    ["Input text", textNode(original.text || "")],
  ];
  section.appendChild(el("div", { class: "source-inputs", role: "group", "aria-label": `${categoryName} source inputs` },
    inputs.map(([label, media]) => el("div", { class: "source-input" }, [
      el("h4", { text: label }),
      el("div", { class: "source-media" }, [media]),
    ]))
  ));

  const tableScroll = el("div", {
    class: "table-scroll", tabindex: "0", role: "region",
    "aria-label": `${categoryName} input conditions and outputs`,
  });
  const table = el("table", { class: "comparison-table examples-table" });
  table.appendChild(el("caption", {
    class: "sr-only", text: `${categoryName} results under four input conditions.`,
  }));
  const headerRow = el("tr");
  [
    ["Input condition", "condition-head"],
    ["Ours (BGM)", "method-ours"],
    ["Ours (Vocal)", "method-ours"],
  ].forEach(([label, className]) => {
    headerRow.appendChild(el("th", { class: className, scope: "col", text: label }));
  });
  table.appendChild(el("thead", {}, [headerRow]));
  const body = el("tbody");
  const sortedRows = (category.rows || []).slice()
    .sort((a, b) => ROW_ORDER.indexOf(a.type) - ROW_ORDER.indexOf(b.type));
  sortedRows.forEach((rowData, index) => body.appendChild(renderExampleRow(rowData, categoryName, index, mediaOptions)));
  table.appendChild(body);
  tableScroll.appendChild(table);
  section.appendChild(tableScroll);
  return section;
}

function sortCategories(categories) {
  return (categories || []).slice().sort((a, b) => {
    const weight = (category) => {
      if (category.id === "live") return 999;
      return (category.orientation || "landscape") === "portrait" ? 0 : 1;
    };
    return weight(a) - weight(b);
  });
}

function queueExampleBatchRender(renderNextBatch, generation) {
  if (
    generation !== exampleRenderState.generation ||
    exampleRenderState.nextBatchQueued
  ) {
    return;
  }
  exampleRenderState.nextBatchQueued = true;
  scheduleLowPriorityWork(() => {
    if (generation !== exampleRenderState.generation) return;
    exampleRenderState.nextBatchQueued = false;
    renderNextBatch();
  });
}

function mountExampleBatches(container, categories, generation) {
  disconnectExampleObservers();

  let index = 0;
  const total = categories.length;
  const sentinel = el("div", {
    class: "examples-sentinel",
    "aria-hidden": "true",
  });

  const renderNextBatch = () => {
    if (
      generation !== exampleRenderState.generation ||
      !sentinel.isConnected ||
      sentinel.parentNode !== container ||
      index >= total
    ) {
      return;
    }

    const fragment = document.createDocumentFragment();
    const end = Math.min(index + EXAMPLES_BATCH_SIZE, total);

    while (index < end) {
      fragment.appendChild(renderCategory(categories[index]));
      index += 1;
    }

    container.insertBefore(fragment, sentinel);

    if (index >= total) {
      sentinel.remove();
      if (exampleRenderState.batchObserver) {
        exampleRenderState.batchObserver.disconnect();
        exampleRenderState.batchObserver = null;
      }
      exampleRenderState.sentinel = null;
      exampleRenderState.loaded = true;
      setStatus("");
      return;
    }

    setStatus(`Examples rendered: ${index}/${total}`);
  };

  container.appendChild(sentinel);
  exampleRenderState.sentinel = sentinel;
  renderNextBatch();

  if (index >= total) return;

  if (typeof window !== "undefined" && "IntersectionObserver" in window) {
    exampleRenderState.batchObserver = new IntersectionObserver(
      (entries) => {
        if (
          generation === exampleRenderState.generation &&
          entries.some((entry) => entry.isIntersecting)
        ) {
          queueExampleBatchRender(renderNextBatch, generation);
        }
      },
      { rootMargin: "280px" }
    );
    exampleRenderState.batchObserver.observe(sentinel);
  } else {
    const renderRemainingBatches = () => {
      renderNextBatch();
      if (index < total) {
        queueExampleBatchRender(renderRemainingBatches, generation);
      }
    };
    queueExampleBatchRender(renderRemainingBatches, generation);
  }
}

async function renderExampleGallery(
  container,
  generation = exampleRenderState.generation
) {
  if (
    generation !== exampleRenderState.generation ||
    exampleRenderState.loading ||
    exampleRenderState.loaded
  ) {
    return;
  }

  exampleRenderState.loading = true;
  container.innerHTML = "";
  setStatus("Loading examples...");

  try {
    const response = await fetch(EXAMPLE_MP4_URL);
    if (!response.ok) throw new Error(`Examples request failed: ${response.status}`);
    const data = await response.json();
    if (generation !== exampleRenderState.generation) return;
    const categories = sortCategories(data.categories);

    container.appendChild(
      el("section", { class: "paper-card examples-intro" }, [
        el("div", { class: "section-head" }, [
          el("h2", {
            class: "page-title",
            text: "Multimodal Generation Examples",
          }),
          el("p", {
            class: "page-subtitle",
            text: "Results under different input conditions",
          }),
        ]),
      ])
    );

    if (categories.length === 0) {
      container.appendChild(
        el("section", { class: "paper-card examples-placeholder" }, [
          el("p", {
            class: "examples-placeholder-copy",
            text: "No example data is available.",
          }),
        ])
      );
      exampleRenderState.loaded = true;
      setStatus("");
      return;
    }

    container.appendChild(el("nav", { class: "category-nav", "aria-label": "Scene categories" },
      categories.map((category) => el("a", { href: `#example-${category.id}`, text: category.name }))
    ));
    mountExampleBatches(container, categories, generation);
  } catch (error) {
    if (generation !== exampleRenderState.generation) return;
    console.error(error);
    container.innerHTML = "";
    container.appendChild(
      el("section", { class: "paper-card examples-placeholder is-error" }, [
        el("h2", {
          class: "examples-placeholder-title",
          text: "More Results",
        }),
        el("p", {
          class: "examples-placeholder-copy",
          text: "The examples could not be loaded.",
        }),
        el("button", {
          type: "button", class: "text-link", text: "Retry",
          onclick: () => renderExampleGallery(container),
        }),
      ])
    );
    setStatus("Failed to load examples.");
  } finally {
    if (generation === exampleRenderState.generation) {
      exampleRenderState.loading = false;
    }
  }
}

function setupDeferredExampleGallery(
  generation = exampleRenderState.generation
) {
  if (generation !== exampleRenderState.generation) return;
  const galleryEl = document.getElementById("videoGallery");
  const triggerEl = document.getElementById("Examples") || galleryEl;
  if (!galleryEl || !triggerEl) return;

  galleryEl.innerHTML = "";
  galleryEl.appendChild(
    el("section", { class: "paper-card examples-placeholder" }, [
      el("h2", {
        class: "examples-placeholder-title",
        text: "More Results",
      }),
      el("p", {
        class: "examples-placeholder-copy",
        text: "Additional multimodal condition results.",
      }),
    ])
  );

  if (typeof window !== "undefined" && "IntersectionObserver" in window) {
    exampleRenderState.triggerObserver = new IntersectionObserver(
      (entries) => {
        if (
          generation !== exampleRenderState.generation ||
          !entries.some((entry) => entry.isIntersecting)
        ) {
          return;
        }
        if (exampleRenderState.triggerObserver) {
          exampleRenderState.triggerObserver.disconnect();
          exampleRenderState.triggerObserver = null;
        }
        scheduleLowPriorityWork(() => {
          if (generation === exampleRenderState.generation) {
            renderExampleGallery(galleryEl, generation);
          }
        });
      },
      { rootMargin: "420px" }
    );
    exampleRenderState.triggerObserver.observe(triggerEl);
  } else {
    scheduleLowPriorityWork(() => {
      if (generation === exampleRenderState.generation) {
        renderExampleGallery(galleryEl, generation);
      }
    });
  }
}

function initAbstractToggle() {
  const text = document.getElementById("abstractText");
  const button = document.getElementById("abstractToggle");
  if (!text || !button) return;
  const compact = window.matchMedia("(max-width: 640px)");
  let expanded = false;
  const update = () => {
    const collapsed = compact.matches && !expanded;
    text.classList.toggle("is-collapsed", collapsed);
    button.hidden = !compact.matches;
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? "Read full abstract" : "Show less";
  };
  button.addEventListener("click", () => { expanded = !expanded; update(); });
  compact.addEventListener("change", update);
  update();
}

function init() {
  const reloadButton = document.getElementById("reloadBtn");
  if (reloadButton) {
    reloadButton.addEventListener("click", () => renderAll());
  }

  initAbstractToggle();
  renderAll();
}

function renderAll() {
  resetRuntimeState();
  const generation = exampleRenderState.generation;

  const compareEl = document.getElementById("tbCompare");
  if (compareEl) renderCompareMatrix(compareEl);

  window.requestAnimationFrame(() => {
    if (generation !== exampleRenderState.generation) return;
    syncCompareCellSizeToCssVars();
    setupDeferredExampleGallery(generation);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
