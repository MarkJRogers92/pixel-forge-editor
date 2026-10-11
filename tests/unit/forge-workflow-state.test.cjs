const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const controllerSource = fs.readFileSync(
  path.join(__dirname, "../../src/js/controller/settings/ForgeController.js"),
  "utf8"
);

class Element {
  constructor(value = "") {
    this.value = value;
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.classList = {
      toggle: (name, active) => {
        this.attributes["class:" + name] = !!active;
      }
    };
  }
  appendChild(child) { this.children.push(child); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector() { return null; }
}

function harness({ storage = {}, fetch } = {}) {
  const elements = new Map();
  const defaults = {
    ".forge-w": "32",
    ".forge-h": "32",
    ".forge-checks": "Readable at game size\nClean dark outline\nNo stray speckles",
    ".forge-prompt": "test sprite",
    ".forge-mode": "prepare",
    ".forge-rounds": "2",
    ".forge-model": "",
    ".forge-target": "new",
    ".forge-candidates": "3",
    ".forge-project": "",
    ".forge-profile": "",
    ".forge-refine-prompt": "",
    ".forge-file": "",
    ".forge-px-w": "",
    ".forge-px-h": "",
    ".forge-px-colors": "16",
    ".forge-px-preset": "standard",
    ".forge-px-palette": "",
    ".forge-px-grid": "",
    ".forge-px-bg": "",
    ".forge-px-orphans": "",
    ".forge-asset-filter": "",
    ".forge-project-path": ""
  };
  function element(selector) {
    const key = selector.replace(/^\.settings-section-forge\s+/, "");
    if (!elements.has(key)) elements.set(key, new Element(defaults[key] || ""));
    return elements.get(key);
  }

  const section = new Element();
  const document = {
    querySelector(selector) {
      if (selector === ".settings-section-forge") return section;
      return element(selector);
    },
    querySelectorAll() { return []; },
    createElement() { return new Element(); }
  };
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = value; },
    removeItem(key) { delete storage[key]; }
  };
  let nextTimer = 1;
  const timers = new Map();
  const window = {
    localStorage,
    location: { search: "" },
    crypto: { randomUUID: () => "test-request-id" },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; }
  };
  const $ = {
    namespace(name) {
      return name.split(".").reduce((obj, part) => obj[part] || (obj[part] = {}), namespaceRoot);
    },
    publish() {}
  };
  function AbstractSettingController() {}
  AbstractSettingController.prototype.addEventListener = function (target, name, callback) {
    target.addEventListener(name, callback);
  };
  const pskl = {
    controller: { settings: { AbstractSettingController } },
    utils: {
      inherit(child, parent) {
        child.prototype = Object.create(parent.prototype);
        child.prototype.constructor = child;
        child.prototype.superclass = parent.prototype;
      }
    }
  };
  const namespaceRoot = { pskl };
  const context = {
    $, pskl, document, window,
    Events: { SHOW_NOTIFICATION: "show", PISKEL_RESET: "reset", PISKEL_SAVE_STATE: "save" },
    fetch,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(controllerSource, context, { filename: "ForgeController.js" });
  const controller = new namespaceRoot.pskl.controller.settings.ForgeController({});
  controller.init();
  async function flushTimers() {
    const pending = [...timers.entries()];
    timers.clear();
    pending.forEach(([, fn]) => fn());
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { controller, elements, storage, timers, flushTimers, window };
}

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

test("restoring a saved workflow disables Generate before the first status response", async () => {
  const storage = {
    "pixelforge.active-workflow": JSON.stringify({
      request_id: "same-id",
      payload: { prompt: "sprite", width: 32, height: 32, project: "dead-mall", checks: [] }
    })
  };
  let releaseStatus;
  const h = harness({ storage, fetch: () => new Promise((resolve) => { releaseStatus = resolve; }) });
  assert.equal(h.elements.get(".forge-generate").disabled, true);
  releaseStatus(jsonResponse({ request_id: "same-id", state: "running", stage: "fixer", previews: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.elements.get(".forge-generate").disabled, true);
});

test("a missing status is recoverable and retry reuses the saved request ID and payload", async () => {
  const calls = [];
  const h = harness({ fetch: (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (options.method === "POST") return jsonResponse({ error: "network dropped" }, 503);
    if (url === "/api/workflows/test-request-id") return jsonResponse({ error: "missing" }, 404);
    if (url === "/api/workflows/prepare") return jsonResponse({ error: "busy", code: "BUSY" }, 409);
    throw new Error("unexpected request " + url);
  }});
  h.controller.startWorkflow_("same sprite");
  await new Promise((resolve) => setImmediate(resolve));
  await h.flushTimers();
  assert.equal(h.elements.get(".forge-generate").disabled, false);
  assert.equal(h.elements.get(".forge-workflow-retry").attributes["class:hidden"], false);
  const firstPost = calls.find((call) => call.url === "/api/workflows/prepare");
  assert.ok(firstPost);
  const payload = JSON.parse(firstPost.options.body);
  h.controller.onWorkflowRetry_();
  await new Promise((resolve) => setImmediate(resolve));
  const posts = calls.filter((call) => call.url === "/api/workflows/prepare");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].options.body).request_id, payload.request_id);
  assert.deepEqual(JSON.parse(posts[1].options.body).checks, payload.checks);
});

test("definitive POST validation errors stop polling and release Generate", async () => {
  const calls = [];
  const h = harness({ fetch: (url, options = {}) => {
    calls.push(url);
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (options.method === "POST") return jsonResponse({ error: "prompt is too long", code: "INVALID_REQUEST" }, 422);
    throw new Error("POST 4xx must not poll status");
  }});
  h.controller.startWorkflow_("ordinary prompt");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.elements.get(".forge-generate").disabled, false);
  assert.match(h.elements.get(".forge-workflow-status").textContent, /prompt is too long/);
  assert.equal(calls.some((url) => url.startsWith("/api/workflows/") && url !== "/api/workflows/prepare"), false);
  assert.equal(h.storage["pixelforge.active-workflow"], undefined);
  assert.ok(h.storage["pixelforge.last-workflow"]);
  const restored = harness({ storage: h.storage, fetch: (url) => {
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    throw new Error("saved local failure should not be polled");
  }});
  assert.match(restored.elements.get(".forge-workflow-status").textContent, /prompt is too long/);
  assert.equal(restored.elements.get(".forge-generate").disabled, false);
});

test("invalid request IDs are terminal and do not keep polling", async () => {
  const storage = {
    "pixelforge.active-workflow": JSON.stringify({ request_id: "bad-id", payload: { prompt: "x" } })
  };
  const h = harness({ storage, fetch: (url) => {
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (url === "/api/workflows/bad-id") return jsonResponse({ error: "invalid request ID" }, 400);
    throw new Error("invalid ID should not be retried");
  }});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.elements.get(".forge-generate").disabled, false);
  assert.match(h.elements.get(".forge-workflow-status").textContent, /rejected this request ID/);
  assert.equal(h.timers.size, 0);
});

test("prompt and check limits reject locally before sending a generation request", async () => {
  const calls = [];
  const h = harness({ fetch: (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    throw new Error("validation should prevent POST");
  }});
  h.controller.startWorkflow_("x".repeat(2001));
  h.controller.q(".forge-checks").value = "x".repeat(501);
  h.controller.startWorkflow_("valid prompt");
  assert.equal(calls.some((call) => call.url === "/api/workflows/prepare"), false);
});

test("request conflicts stay distinct from BUSY responses", async () => {
  const h = harness({ fetch: (url, options = {}) => {
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (options.method === "POST") return jsonResponse({ error: { code: "REQUEST_CONFLICT", message: "payload mismatch" } }, 409);
    throw new Error("conflict must not poll");
  }});
  h.controller.startWorkflow_("sprite");
  await new Promise((resolve) => setImmediate(resolve));
  const status = h.elements.get(".forge-workflow-status").textContent;
  assert.match(status, /request ID conflict/);
  assert.doesNotMatch(status, /Another Forge workflow is already running/);
});

test("active workflows reach completed and cancelled states without resubmitting or auto-applying", async () => {
  const calls = [];
  let statusReads = 0;
  const h = harness({ fetch: (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (url === "/api/workflows/prepare") return jsonResponse({ request_id: "test-request-id", state: "running" });
    if (url === "/api/workflows/test-request-id") {
      statusReads++;
      return jsonResponse(statusReads === 1
        ? { request_id: "test-request-id", state: "running", stage: "fixer", previews: [] }
        : { request_id: "test-request-id", state: "completed", result: { library_id: "sprite-1", png: "/sprite.png", review_png: "/review.png" } });
    }
    throw new Error("unexpected request " + url);
  }});
  h.controller.startWorkflow_("sprite");
  await new Promise((resolve) => setImmediate(resolve));
  await h.flushTimers();
  await h.flushTimers();
  assert.equal(calls.filter((call) => call.url === "/api/workflows/prepare").length, 1);
  assert.equal(h.elements.get(".forge-workflow-open").attributes["class:hidden"], false);
  assert.equal(h.elements.get(".forge-workflow-status").textContent.includes("Ready for visual review"), true);
  assert.equal(h.elements.get(".forge-review-sheet").children.length > 0, true);
  assert.equal(calls.some((call) => call.url === "/api/workflows/test-request-id" && call.options.method === "POST"), false);
});

test("cancellation follows the server state and remains distinct from failure", async () => {
  const calls = [];
  let statusReads = 0;
  const h = harness({ fetch: (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/status") return jsonResponse({ backends: {}, profiles: [] });
    if (url === "/api/workflows/prepare") return jsonResponse({ request_id: "test-request-id", state: "running" });
    if (url === "/api/workflows/test-request-id/cancel") return jsonResponse({ request_id: "test-request-id", state: "cancelling" });
    if (url === "/api/workflows/test-request-id") {
      statusReads++;
      return jsonResponse({ request_id: "test-request-id", state: statusReads === 1 ? "running" : "cancelled" });
    }
    throw new Error("unexpected request " + url);
  }});
  h.controller.startWorkflow_("sprite");
  await new Promise((resolve) => setImmediate(resolve));
  await h.flushTimers();
  h.controller.onWorkflowCancel_();
  await new Promise((resolve) => setImmediate(resolve));
  await h.flushTimers();
  assert.equal(calls.filter((call) => call.url === "/api/workflows/prepare").length, 1);
  assert.equal(h.elements.get(".forge-workflow-status").textContent.includes("Cancelled"), true);
  assert.equal(h.elements.get(".forge-workflow-status").textContent.includes("Generation failed"), false);
});
