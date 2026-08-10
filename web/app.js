const EXAMPLE_MP4_URL = new URL("./data/example_mp4.json", import.meta.url).href;

const ROW_CASES = ["1", "2", "3", "4", "5"];
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
  Diff_bgm: "Diff-BGM",
  M2UGen: "M2UGen",
};
const SEPARATOR_COL_INDICES = [0];
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
const EXAMPLES_BATCH_SIZE = 2;
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

  const cleanup = () => {
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

function createVideoElement(src) {
  return el("video", {
    src: resolveMediaSrc(src),
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
    enqueueAllVideosInOrder();
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
  const loadingIndicator = createLoadingIndicator(label);

  wrapper.appendChild(loadingIndicator);
  wrapper.title = label;

  if (options.syncAspectRatio) {
    wrapper.style.aspectRatio = "16 / 9";
  }

  const mountVideo = () => {
    if (wrapper.querySelector("video")) return;

    const resolved = resolveMediaSrc(src);
    const video = createVideoElement(src);
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

    if (options.syncAspectRatio) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (video.videoWidth && video.videoHeight) {
            wrapper.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
          }
        },
        { once: true }
      );
    }

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
      el("h4", {
        class: "section-kicker",
        text: "Comparison with Other Methods",
      }),
      el("p", {
        class: "page-subtitle",
        text: "Each row uses the same source case so the methods can be reviewed in a stable, aligned comparison.",
      }),
    ])
  );

  const tableScroll = el("div", { class: "table-scroll" });
  const table = el("table", { class: "comparison-table" });
  table.appendChild(
    el("caption", {
      text: "Five cases compared across Ground Truth, NingBGM, and six baseline methods.",
    })
  );

  const headerRow = el("tr");
  headerRow.appendChild(el("th", { class: "case-head", scope: "col", text: "Case" }));
  COL_MODELS.forEach((model) => {
    const header = el("th", {
      scope: "col",
      text: MODEL_LABELS[model] || model,
    });
    if (model === "Ours") header.classList.add("method-ours");
    headerRow.appendChild(header);
  });
  table.appendChild(el("thead", {}, [headerRow]));

  const body = el("tbody");
  ROW_CASES.forEach((caseId) => {
    const row = el("tr");
    row.appendChild(el("th", { class: "case-label", scope: "row", text: `Case ${caseId}` }));
    COL_MODELS.forEach((model) => {
      const cell = el("td", { class: "compare-cell" });
      cell.appendChild(
        mediaNode(getCompareVideoPath(model, caseId), MODEL_LABELS[model] || model, true, {
          syncAspectRatio: true,
        })
      );
      row.appendChild(cell);
    });
    body.appendChild(row);
  });

  table.appendChild(body);
  tableScroll.appendChild(table);
  container.appendChild(tableScroll);
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

  if (options.syncAspectRatio !== false) {
    img.addEventListener("load", () => {
      if (img.naturalWidth && img.naturalHeight) {
        wrapper.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
    });
  }

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

function renderExampleRow(original, rowData, orientation = "landscape") {
  const row = el("tr");
  const type = rowData.type;
  const mediaOptions = { syncAspectRatio: false };

  row.appendChild(
    el("th", {
      class: "condition-label",
      scope: "row",
      text: rowData.label || type,
    })
  );

  if (type === "video_audio_image_text" || type === "video_image_text") {
    row.appendChild(
      el("td", { class: "example-media-cell input-video-cell" }, [
        original.video
          ? mediaNode(original.video, "Input video", true, mediaOptions)
          : placeholderNode("video"),
      ])
    );
  } else {
    row.appendChild(
      el("td", { class: "example-media-cell input-video-cell" }, [
        placeholderNode("video"),
      ])
    );
  }

  row.appendChild(
    el("td", { class: "example-media-cell input-image-cell" }, [
      original.image
        ? imageNode(original.image, "Input image", { syncAspectRatio: false })
        : placeholderNode("image"),
    ])
  );

  if (type === "video_audio_image_text" || type === "audio_image_text") {
    row.appendChild(
      el("td", { class: "example-media-cell input-audio-cell" }, [
        original.audio
          ? audioNode(original.audio, "Input audio")
          : placeholderNode("audio"),
      ])
    );
  } else {
    row.appendChild(
      el("td", { class: "example-media-cell input-audio-cell" }, [
        placeholderNode("audio"),
      ])
    );
  }

  row.appendChild(
    el("td", { class: "example-media-cell input-text-cell" }, [
      textNode(original.text || ""),
    ])
  );
  row.appendChild(
    el("td", { class: "example-media-cell output-cell" }, [
      rowData.output?.bgm
        ? mediaNode(rowData.output.bgm, "Ours BGM", true, mediaOptions)
        : placeholderNode("video"),
    ])
  );
  row.appendChild(
    el("td", { class: "example-media-cell output-cell" }, [
      rowData.output?.vocal
        ? mediaNode(rowData.output.vocal, "Ours Vocal", true, mediaOptions)
        : placeholderNode("video"),
    ])
  );

  return row;
}

function renderCategory(category) {
  const orientation = category.orientation || "landscape";
  const section = el("section", {
    class: `paper-card example-category ${orientation}`,
    id: `example-${category.id || "category"}`,
  });

  section.appendChild(
    el("h2", { class: "category-title", text: category.name || "Category" })
  );
  section.appendChild(
    el("h4", { class: "category-subtitle", text: "Multimodal Condition Study" })
  );

  const tableScroll = el("div", { class: "table-scroll" });
  const table = el("table", {
    class: "comparison-table examples-table",
  });
  table.appendChild(
    el("caption", {
      text: `${category.name || "Category"} results under four input conditions.`,
    })
  );

  const headerRow = el("tr");
  [
    ["Condition", "condition-head"],
    ["Input Video", ""],
    ["Input Image", ""],
    ["Input Audio", ""],
    ["Input Text", ""],
    ["Ours (BGM)", "method-ours"],
    ["Ours (Vocal)", "method-ours"],
  ].forEach(([label, className]) => {
    headerRow.appendChild(
      el("th", { class: className, scope: "col", text: label })
    );
  });
  table.appendChild(el("thead", {}, [headerRow]));

  const body = el("tbody");
  const sortedRows = (category.rows || [])
    .slice()
    .sort((a, b) => ROW_ORDER.indexOf(a.type) - ROW_ORDER.indexOf(b.type));

  sortedRows.forEach((rowData) => {
    body.appendChild(renderExampleRow(category.original || {}, rowData, orientation));
  });

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
            text: data.title || "More Results",
          }),
          el("h4", {
            class: "section-kicker",
            text: "Multimodal Condition Studies",
          }),
          el("p", {
            class: "page-subtitle",
            text: "Each category compares the same source under four available-modality conditions.",
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
  text.classList.remove("is-collapsed");
  button.hidden = true;
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
