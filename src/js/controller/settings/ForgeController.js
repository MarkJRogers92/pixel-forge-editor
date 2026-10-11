/* @file AI Forge panel: sprite generation, refinement and pixelization.
 * Talks to the local Pixel Forge server (/api/*) that also serves this editor. */
(function () {
  var ns = $.namespace("pskl.controller.settings");

  // Survives the drawer being closed/reopened (controllers are recreated each time).
  var state = { job: null, log: [], results: [], busy: false, status: null, prefs: {}, workflow: null, controller: null };
  var PREFS_KEY = "pixelforge.prefs";
  var WORKFLOW_KEY = "pixelforge.active-workflow";
  var WORKFLOW_HISTORY_KEY = "pixelforge.last-workflow";
  try {
    state.prefs = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}");
  } catch (e) {
    state.prefs = {};
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (e) {}
  }

  function api(method, path, body) {
    return fetch("/api/" + path, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) {
          var error = new Error(j.error || "HTTP " + r.status);
          error.status = r.status;
          error.body = j;
          throw error;
        }
        return j;
      });
    });
  }

  function notify(text) {
    $.publish(Events.SHOW_NOTIFICATION, [{ content: text, hideDelay: 4000 }]);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  /** Current frame (all visible layers flattened) as a PNG data URL. */
  function currentFrameDataUrl() {
    var pc = pskl.app.piskelController;
    var canvas = pskl.utils.LayerUtils.flattenFrameAt(
      pc.getLayers(),
      pc.getCurrentFrameIndex(),
      true
    );
    return canvas.toDataURL("image/png");
  }

  /** Put a PNG into the editor: as a new sprite, or as a new layer on the current frame. */
  function applyImage(dataUrl, target, name) {
    return loadImage(dataUrl).then(function (img) {
      var pc = pskl.app.piskelController;
      if (target === "layer") {
        pc.createLayer("AI " + new Date().toLocaleTimeString());
        var frame = pc.getCurrentFrame();
        var canvas = pskl.utils.CanvasUtils.createFromImage(img);
        var data = canvas
          .getContext("2d")
          .getImageData(0, 0, img.width, img.height).data;
        var ox = Math.floor((frame.getWidth() - img.width) / 2);
        var oy = Math.floor((frame.getHeight() - img.height) / 2);
        for (var y = 0; y < img.height; y++) {
          for (var x = 0; x < img.width; x++) {
            var i = (y * img.width + x) * 4;
            if (data[i + 3] >= 128) {
              var hex =
                "#" +
                [data[i], data[i + 1], data[i + 2]]
                  .map(function (v) {
                    return ("0" + v.toString(16)).slice(-2);
                  })
                  .join("");
              if (frame.containsPixel(x + ox, y + oy)) {
                frame.setPixel(x + ox, y + oy, pskl.utils.colorToInt(hex));
              }
            }
          }
        }
        $.publish(Events.PISKEL_RESET);
        $.publish(Events.PISKEL_SAVE_STATE, {
          type: pskl.service.HistoryService.SNAPSHOT
        });
        return;
      }
      return new Promise(function (resolve) {
        pskl.app.importService.newPiskelFromImage(
          img,
          {
            importType: "single",
            name: name || "AI sprite",
            smoothing: false,
            frameSizeX: img.width,
            frameSizeY: img.height
          },
          function (piskel) {
            pc.setPiskel(piskel);
            resolve();
          }
        );
      });
    });
  }

  // `?open=<library id>` (forge open ID --editor piskel): once Piskel is up, load that
  // result as a new sprite. Runs at page load, not when the AI panel is first opened.
  (function openFromUrl() {
    var openId = new URLSearchParams(window.location.search).get("open");
    if (!openId) return;
    var tries = 0;
    var timer = window.setInterval(function () {
      tries++;
      var ready = window.pskl && pskl.app && pskl.app.piskelController && pskl.app.importService;
      if (!ready && tries < 100) return;
      window.clearInterval(timer);
      if (ready) applyImage("/api/library/" + encodeURIComponent(openId) + "/sprite.png", "new", openId);
    }, 100);
  })();

  ns.ForgeController = function (piskelController) {
    this.piskelController = piskelController;
  };

  pskl.utils.inherit(
    ns.ForgeController,
    pskl.controller.settings.AbstractSettingController
  );

  ns.ForgeController.prototype.init = function () {
    var q = function (sel) {
      return document.querySelector(".settings-section-forge " + sel);
    };
    this.q = q;
    this.statusEl = q(".forge-status");
    this.logEl = q(".forge-log");
    this.resultsEl = q(".forge-results");
    this.libraryEl = q(".forge-library");
    this.assetsEl = q(".forge-assets");
    state.controller = this;

    var tabs = document.querySelectorAll(".settings-section-forge .forge-tab");
    for (var i = 0; i < tabs.length; i++) {
      this.addEventListener(tabs[i], "click", this.onTab_);
    }
    this.addEventListener(q(".forge-generate"), "click", this.onGenerate_);
    this.addEventListener(q(".forge-mode"), "change", this.onModeChange_);
    this.addEventListener(q(".forge-workflow-cancel"), "click", this.onWorkflowCancel_);
    this.addEventListener(q(".forge-workflow-open"), "click", this.onWorkflowOpen_);
    this.addEventListener(q(".forge-workflow-retry"), "click", this.onWorkflowRetry_);
    this.addEventListener(q(".forge-refine"), "click", this.onRefine_);
    this.addEventListener(q(".forge-pixelize"), "click", this.onPixelize_);
    this.addEventListener(q(".forge-use-canvas-size"), "click", this.onCanvasSize_);
    this.addEventListener(this.resultsEl, "click", this.onResultClick_);
    this.addEventListener(this.libraryEl, "click", this.onLibraryClick_);
    this.addEventListener(this.assetsEl, "click", this.onAssetClick_);
    this.addEventListener(q(".forge-project"), "change", this.loadAssets_);
    this.addEventListener(q(".forge-asset-filter"), "input", this.renderAssets_);
    this.addEventListener(q(".forge-project-add"), "click", this.onAddProject_);
    this.addEventListener(q(".forge-learn"), "click", this.onLearn_);

    // stop Piskel's keyboard shortcuts while typing
    var fields = document.querySelectorAll(
      ".settings-section-forge textarea, .settings-section-forge input"
    );
    for (var j = 0; j < fields.length; j++) {
      this.addEventListener(fields[j], "keydown", function (e) {
        e.stopPropagation();
      });
    }

    var p = state.prefs;
    if (p.w) q(".forge-w").value = p.w;
    if (p.h) q(".forge-h").value = p.h;
    if (p.rounds !== undefined) q(".forge-rounds").value = p.rounds;
    if (p.model) q(".forge-model").value = p.model;
    if (p.project) this.pendingProject = p.project;
    if (p.target) q(".forge-target").value = p.target;
    if (p.candidates) q(".forge-candidates").value = p.candidates;
    if (p.prompt) q(".forge-prompt").value = p.prompt;
    if (p.checks) q(".forge-checks").value = p.checks;
    if (p.mode) q(".forge-mode").value = p.mode;
    this.updateMode_();

    try {
      var savedWorkflow = JSON.parse(
        window.localStorage.getItem(WORKFLOW_KEY) ||
        window.localStorage.getItem(WORKFLOW_HISTORY_KEY) ||
        "null"
      );
      if (savedWorkflow && savedWorkflow.request_id) {
        state.workflowId = savedWorkflow.request_id;
        state.workflowPayload = savedWorkflow.payload || null;
        if (savedWorkflow.terminal) state.workflow = savedWorkflow.terminal;
        state.busy = !!(savedWorkflow.terminal && isWorkflowActive(savedWorkflow.terminal.state)) || !savedWorkflow.terminal;
      }
    } catch (e) {}

    this.loadStatus_();
    if (state.workflowId && !(savedWorkflow && savedWorkflow.local_terminal)) {
      // Set synchronously before render_ so Generate cannot race recovery.
      state.busy = true;
      pollWorkflow(state.workflowId, true);
    }
    renderWorkflow();
    this.render_();

    var self = this;
    this.ticker = window.setInterval(function () {
      self.render_();
    }, 700);
  };

  ns.ForgeController.prototype.destroy = function () {
    window.clearInterval(this.ticker);
    if (state.controller === this) state.controller = null;
    this.superclass.destroy.call(this);
  };

  ns.ForgeController.prototype.onModeChange_ = function () {
    state.prefs.mode = this.q(".forge-mode").value;
    savePrefs();
    this.updateMode_();
  };

  ns.ForgeController.prototype.updateMode_ = function () {
    var mode = this.q(".forge-mode").value === "competition" ? "competition" : "prepare";
    this.q(".forge-mode").value = mode;
    var section = document.querySelector(".settings-section-forge");
    section.classList.toggle("forge-mode-prepare", mode === "prepare");
    section.classList.toggle("forge-mode-competition", mode === "competition");
  };

  ns.ForgeController.prototype.onWorkflowCancel_ = function () {
    var id = state.workflowId;
    if (!id || !state.workflow || !isWorkflowActive(state.workflow.state)) return;
    state.workflowCancelError = "";
    api("POST", "workflows/" + encodeURIComponent(id) + "/cancel", {})
      .then(function (r) {
        state.workflow = r;
        pollWorkflow(id, false);
      })
      .catch(function (e) {
        state.workflowCancelError = "Could not cancel yet: " + e.message;
        renderWorkflow();
      });
    renderWorkflow();
  };

  ns.ForgeController.prototype.onWorkflowOpen_ = function () {
    var result = state.workflow && state.workflow.result;
    if (!result || !result.png) return;
    applyImage(result.png, "new", result.library_id || "Pixel Forge result").then(function () {
      notify("Opened the final sprite as a new image");
    }).catch(function () {
      notify("Could not open the final sprite");
    });
  };

  ns.ForgeController.prototype.onWorkflowRetry_ = function () {
    if (!state.workflowId || !state.workflowPayload || !state.workflow || state.workflow.state !== "missing") return;
    submitWorkflow(state.workflowId, state.workflowPayload);
  };

  function isWorkflowActive(status) {
    return status === "starting" || status === "running" || status === "cancelling";
  }

  function persistWorkflowRecord(id, payload, terminal, localTerminal) {
    state.workflowId = id;
    try {
      var record = JSON.stringify({
        request_id: id,
        payload: payload || state.workflowPayload || null,
        terminal: terminal || null,
        local_terminal: !!localTerminal
      });
      if (terminal && !isWorkflowActive(terminal.state)) {
        window.localStorage.removeItem(WORKFLOW_KEY);
        window.localStorage.setItem(WORKFLOW_HISTORY_KEY, record);
      } else {
        window.localStorage.setItem(WORKFLOW_KEY, record);
        window.localStorage.removeItem(WORKFLOW_HISTORY_KEY);
      }
    } catch (e) {}
  }

  function pollWorkflow(id, immediate) {
    if (state.workflowPolling) return;
    state.workflowPolling = true;
    function tick() {
      api("GET", "workflows/" + encodeURIComponent(id))
        .then(function (workflow) {
          state.workflow = workflow;
          state.workflowPayload = state.workflowPayload || null;
          state.workflowError = "";
          state.busy = isWorkflowActive(workflow.state);
          persistWorkflowRecord(id, state.workflowPayload, state.busy ? null : workflow, false);
          renderWorkflow();
          if (state.busy) {
            state.workflowTimer = window.setTimeout(tick, 1500);
          } else {
            state.workflowPolling = false;
          }
        })
        .catch(function (e) {
          if (e.status === 404) {
            state.busy = false;
            state.workflow = {
              request_id: id,
              state: "missing",
              log: "Forge cannot find this request. Retry this same request ID to recover safely."
            };
            state.workflowError = "";
            state.workflowPolling = false;
            persistWorkflowRecord(id, state.workflowPayload, state.workflow, true);
            renderWorkflow();
            return;
          }
          if (e.status === 400) {
            state.busy = false;
            state.workflow = {
              request_id: id,
              state: "failed",
              log: "Forge rejected this request ID. Start a new request to continue."
            };
            state.workflowError = "";
            state.workflowPolling = false;
            persistWorkflowRecord(id, state.workflowPayload, state.workflow, true);
            renderWorkflow();
            return;
          }
          // Keep polling this same request ID. A refresh or lost response must never
          // turn into an accidental second generation.
          state.busy = true;
          state.workflowError = "Status connection lost. Forge will keep checking this request.";
          renderWorkflow();
          state.workflowTimer = window.setTimeout(tick, 3000);
        });
    }
    if (immediate) tick();
    else state.workflowTimer = window.setTimeout(tick, 250);
  }

  function renderWorkflow() {
    var controller = state.controller;
    if (!controller || !controller.q) return;
    var status = controller.q(".forge-workflow-status");
    var previews = controller.q(".forge-workflow-previews");
    var review = controller.q(".forge-review-sheet");
    var cancel = controller.q(".forge-workflow-cancel");
    var open = controller.q(".forge-workflow-open");
    var retry = controller.q(".forge-workflow-retry");
    var workflow = state.workflow;
    status.textContent = "";
    cancel.classList.toggle("hidden", !workflow || !isWorkflowActive(workflow.state));
    open.classList.toggle("hidden", !(workflow && workflow.state === "completed" && workflow.result && workflow.result.png));
    retry.classList.toggle("hidden", !(workflow && workflow.state === "missing" && state.workflowPayload));
    controller.q(".forge-generate").disabled = state.busy;
    if (!workflow) {
      if (state.workflowError) status.textContent = state.workflowError;
      else if (state.busy && state.workflowId) status.textContent = "Restoring saved Forge request…";
      return;
    }
    var messages = [];
    var labels = {
      starting: "Starting",
      running: "Working",
      cancelling: "Cancelling",
      cancelled: "Cancelled",
      completed: "Ready for visual review",
      failed: "Generation failed",
      interrupted: "Generation was interrupted"
    };
    messages.push(labels[workflow.state] || workflow.state || "Workflow status");
    if (workflow.stage) messages.push("Stage: " + workflow.stage);
    if (workflow.log) {
      messages.push(Array.isArray(workflow.log) ? workflow.log.join("\n") : String(workflow.log));
    }
    if (state.workflowError) messages.push(state.workflowError);
    if (state.workflowCancelError) messages.push(state.workflowCancelError);
    if (workflow.state === "completed") {
      messages.push("Forge's checks are ready. Please judge the art at 1× and 2×; QA is not artistic approval.");
    }
    status.textContent = messages.join("\n");
    var previewList = (workflow.previews || []).filter(function (preview) {
      return preview && preview.png;
    });
    var previewSignature = JSON.stringify(previewList.map(function (preview) {
      return [preview.kind || "Preview", preview.png];
    }));
    if (previews.getAttribute("data-signature") !== previewSignature) {
      previews.textContent = "";
      previewList.forEach(function (preview) {
        var card = document.createElement("div");
        card.className = "forge-thumb";
        var image = document.createElement("img");
        image.src = preview.png;
        image.alt = preview.kind || "Generation preview";
        var label = document.createElement("span");
        label.textContent = preview.kind || "Preview";
        card.appendChild(image);
        card.appendChild(label);
        previews.appendChild(card);
      });
      previews.setAttribute("data-signature", previewSignature);
    }
    var result = workflow.result;
    var reviewUrl = workflow.state === "completed" && result && result.review_png ? result.review_png : "";
    if (review.getAttribute("data-signature") !== reviewUrl) {
      review.textContent = "";
      if (reviewUrl) {
        var heading = document.createElement("div");
        heading.className = "forge-help";
        heading.textContent = "Review sheet · compare at 1× and 2×";
        var imageCard = document.createElement("div");
        imageCard.className = "forge-thumb";
        var sheet = document.createElement("img");
        sheet.src = reviewUrl;
        sheet.alt = "Pixel Forge visual review sheet showing the sprite at 1× and 2×";
        imageCard.appendChild(sheet);
        review.appendChild(heading);
        review.appendChild(imageCard);
      }
      review.setAttribute("data-signature", reviewUrl);
    }
  }

  ns.ForgeController.prototype.onTab_ = function (evt) {
    var tab = evt.target.getAttribute("data-forge-tab");
    var tabs = document.querySelectorAll(".settings-section-forge .forge-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("selected", tabs[i] === evt.target);
    }
    var panes = document.querySelectorAll(".settings-section-forge .forge-pane");
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle(
        "hidden",
        panes[j].getAttribute("data-forge-pane") !== tab
      );
    }
    if (tab === "library") {
      this.loadLibrary_();
      this.loadProjects_();
    }
  };

  ns.ForgeController.prototype.loadStatus_ = function () {
    var self = this;
    api("GET", "status")
      .then(function (s) {
        state.status = s;
        var names = Object.keys(s.backends);
        var labels = { cli: "Claude", codex: "GPT (Codex)", api: "Claude API" };
        var artistSel = self.q(".forge-artist");
        artistSel.innerHTML = "";
        names.forEach(function (n) {
          var o = document.createElement("option");
          o.value = n;
          o.textContent = labels[n] || n;
          artistSel.appendChild(o);
        });
        if (s.backends.codex && s.backends.cli) {
          var hy = document.createElement("option");
          hy.value = "gpt-image";
          hy.textContent = "GPT paints + Claude refines (most detail)";
          artistSel.appendChild(hy);
        }
        if (state.prefs.artist && artistSel.querySelector("option[value='" + state.prefs.artist + "']")) {
          artistSel.value = state.prefs.artist;
        }
        self.statusEl.textContent = names.length
          ? "Artists: " + names.map(function (n) { return labels[n] || n; }).join(", ")
          : "No artist found (install the claude or codex CLI, or set ANTHROPIC_API_KEY)";
        var sel = self.q(".forge-profile");
        s.profiles.forEach(function (p) {
          var o = document.createElement("option");
          o.value = p.id;
          o.textContent = p.name + (p.colors ? " (" + p.colors + " colours)" : "");
          sel.appendChild(o);
        });
        if (state.prefs.profile) sel.value = state.prefs.profile;
      })
      .catch(function (e) {
        self.statusEl.textContent = "Forge server not reachable: " + e.message;
      });
  };

  ns.ForgeController.prototype.onCanvasSize_ = function () {
    this.q(".forge-w").value = this.piskelController.getWidth();
    this.q(".forge-h").value = this.piskelController.getHeight();
  };

  ns.ForgeController.prototype.startJob_ = function (body, target, label) {
    if (state.busy) {
      notify("Claude is still working on the previous request");
      return;
    }
    state.busy = true;
    state.log = ["starting: " + label];
    state.results = [];
    api("POST", "generate", body)
      .then(function (r) {
        state.job = r.job;
        poll(r.job, target, label);
      })
      .catch(function (e) {
        state.busy = false;
        state.log.push("error: " + e.message);
      });
  };

  ns.ForgeController.prototype.startWorkflow_ = function (prompt) {
    if (state.busy) {
      notify("Forge is still working on the previous request");
      return;
    }
    var q = this.q;
    var width = Number(q(".forge-w").value);
    var height = Number(q(".forge-h").value);
    if (!Number.isInteger(width) || width < 16 || width > 512 || !Number.isInteger(height) || height < 16 || height > 512) {
      notify("Sprite size must be between 16 and 512 pixels in each direction");
      return;
    }
    if (prompt.length > 2000) {
      notify("Keep the sprite description to 2,000 characters or fewer");
      return;
    }
    var checks = q(".forge-checks").value.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    if (checks.length > 8) {
      notify("Use no more than 8 visible checks");
      return;
    }
    if (checks.some(function (check) { return check.length > 500; })) {
      notify("Keep each visible check to 500 characters or fewer");
      return;
    }
    var requestId = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : "wf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    state.prefs.mode = "prepare";
    state.prefs.w = width;
    state.prefs.h = height;
    state.prefs.prompt = prompt;
    state.prefs.checks = checks.join("\n");
    savePrefs();
    var payload = {
      prompt: prompt,
      width: width,
      height: height,
      project: "dead-mall",
      checks: checks
    };
    state.workflowPayload = payload;
    submitWorkflow(requestId, payload);
  };

  function responseError(e) {
    var body = e && e.body;
    var detail = body && body.error;
    if (detail && typeof detail === "object") detail = detail.message || detail.code;
    return String(detail || (e && e.message) || "Request failed");
  }

  function responseCode(e) {
    var body = e && e.body;
    var error = body && body.error;
    return String((body && body.code) || (error && typeof error === "object" && error.code) || "").toUpperCase();
  }

  function submitWorkflow(id, payload) {
    state.workflowId = id;
    state.workflowPayload = payload;
    state.workflow = { request_id: id, state: "starting", stage: "Queued", log: [] };
    state.workflowError = "";
    state.workflowCancelError = "";
    state.busy = true;
    persistWorkflowRecord(id, payload, null, false);
    renderWorkflow();
    api("POST", "workflows/prepare", Object.assign({ request_id: id }, payload))
      .then(function (workflow) {
        state.workflow = workflow;
        state.busy = isWorkflowActive(workflow.state);
        state.workflowError = "";
        persistWorkflowRecord(id, payload, state.busy ? null : workflow, false);
        renderWorkflow();
        if (state.busy) pollWorkflow(id, false);
      })
      .catch(function (e) {
        var code = responseCode(e);
        var message = responseError(e);
        if (code === "REQUEST_CONFLICT") {
          state.busy = false;
          state.workflow = { request_id: id, state: "failed", log: "Forge found a request ID conflict. Start a fresh request to continue." };
          state.workflowError = "";
          persistWorkflowRecord(id, payload, state.workflow, true);
          renderWorkflow();
          return;
        }
        if (code === "BUSY" || (code !== "REQUEST_CONFLICT" && /\bBUSY\b|another workflow|already running/i.test(message))) {
          state.busy = false;
          state.workflow = { request_id: id, state: "failed", log: "Another Forge workflow is already running. Check its progress before starting a new one." };
          state.workflowError = "";
          persistWorkflowRecord(id, payload, state.workflow, true);
          renderWorkflow();
          return;
        }
        if (e.status >= 400 && e.status < 500) {
          state.busy = false;
          state.workflow = { request_id: id, state: "failed", log: "Forge could not start this request: " + message };
          state.workflowError = "";
          persistWorkflowRecord(id, payload, state.workflow, true);
          renderWorkflow();
          return;
        }
        // The POST may have reached Forge even when its response was lost. Keep the
        // same ID and resolve it through GET; never submit a replacement request.
        state.busy = true;
        state.workflowError = "Could not confirm the start yet. Forge will check this same request.";
        persistWorkflowRecord(id, payload, null, false);
        renderWorkflow();
        pollWorkflow(id, false);
      });
  }

  function poll(jobId, target, label) {
    api("GET", "jobs/" + jobId)
      .then(function (j) {
        state.log = ["starting: " + label].concat(j.log);
        if (j.status === "running") {
          window.setTimeout(function () {
            poll(jobId, target, label);
          }, 1500);
          return;
        }
        state.busy = false;
        if (j.status === "done") {
          state.results = j.result.steps;
          applyImage(j.result.png, target, label).then(function () {
            notify("Claude finished: " + label);
          });
        }
      })
      .catch(function (e) {
        state.busy = false;
        state.log.push("error: " + e.message);
      });
  }

  ns.ForgeController.prototype.onGenerate_ = function () {
    var q = this.q;
    var prompt = q(".forge-prompt").value.trim();
    if (!prompt) {
      notify("Describe the sprite first");
      return;
    }
    if (q(".forge-mode").value !== "competition") {
      this.startWorkflow_(prompt);
      return;
    }
    var p = state.prefs;
    p.w = q(".forge-w").value;
    p.h = q(".forge-h").value;
    p.rounds = q(".forge-rounds").value;
    p.model = q(".forge-model").value;
    p.artist = q(".forge-artist").value;
    p.candidates = q(".forge-candidates").value;
    p.target = q(".forge-target").value;
    p.profile = q(".forge-profile").value;
    p.prompt = prompt;
    savePrefs();
    this.startJob_(
      {
        prompt: prompt,
        width: +p.w,
        height: +p.h,
        rounds: +p.rounds,
        candidates: +p.candidates,
        backend: p.artist,
        model: p.artist === "cli" || p.artist === "api" ? p.model : "",
        profile: p.profile
      },
      p.target,
      prompt.slice(0, 40)
    );
  };

  ns.ForgeController.prototype.onRefine_ = function () {
    var q = this.q;
    var text = q(".forge-refine-prompt").value.trim();
    if (!text) {
      notify("Say what to change");
      return;
    }
    this.startJob_(
      {
        prompt: text,
        base_png: currentFrameDataUrl(),
        rounds: Math.min(+q(".forge-rounds").value || 1, 2),
        model: q(".forge-artist").value === "codex" ? "" : q(".forge-model").value,
        backend: q(".forge-artist").value === "gpt-image" ? "cli" : q(".forge-artist").value,
        profile: q(".forge-profile").value,
        use_references: false
      },
      "layer",
      "refine: " + text.slice(0, 30)
    );
  };

  ns.ForgeController.prototype.onPixelize_ = function () {
    var q = this.q;
    var file = q(".forge-file").files[0];
    var read = file
      ? new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () {
            resolve(fr.result);
          };
          fr.readAsDataURL(file);
        })
      : Promise.resolve(currentFrameDataUrl());
    var body = {
      name: file ? file.name.replace(/\.[^.]+$/, "") : "frame",
      width: +q(".forge-px-w").value || null,
      height: +q(".forge-px-h").value || null,
      max_colors: +q(".forge-px-colors").value || 16,
      preset: q(".forge-px-preset").value,
      profile: q(".forge-profile").value,
      use_palette: q(".forge-px-palette").checked,
      detect_grid: q(".forge-px-grid").checked,
      remove_background: q(".forge-px-bg").checked ? "auto" : "none",
      remove_orphans: q(".forge-px-orphans").checked
    };
    state.log = ["pixelizing " + body.name + "…"];
    read
      .then(function (dataUrl) {
        body.image = dataUrl;
        return api("POST", "cleanup", body);
      })
      .then(function (r) {
        state.log = ["pixelized " + body.name]
          .concat(r.report.notes)
          .concat([
            "output " + r.report.output_size.join("×") + ", " + r.report.colors + " colours",
            "QA: " + (r.qa.warnings.join("; ") || "no warnings")
          ]);
        state.results = [{ kind: "pixelized", png: r.png, qa: r.qa, notes: "", errors: [] }];
        return applyImage(r.png, "new", body.name);
      })
      .catch(function (e) {
        state.log.push("error: " + e.message);
      });
  };

  ns.ForgeController.prototype.onResultClick_ = function (evt) {
    var idx = evt.target.getAttribute("data-step");
    if (idx === null) return;
    var step = state.results[+idx];
    if (step) {
      applyImage(step.png, "new", "AI step " + idx);
    }
  };

  ns.ForgeController.prototype.loadLibrary_ = function () {
    var el = this.libraryEl;
    api("GET", "library").then(function (r) {
      el.innerHTML = r.items.length ? "" : "<p class='forge-help'>Nothing yet.</p>";
      r.items.forEach(function (it) {
        var d = document.createElement("div");
        d.className = "forge-thumb";
        d.title = it.prompt + (it.size ? " (" + it.size.join("×") + ")" : "");
        d.innerHTML =
          "<img data-lib='" + it.id + "' src='/api/library/" + it.id + "/sprite.png'/>";
        el.appendChild(d);
      });
    });
  };

  ns.ForgeController.prototype.loadProjects_ = function () {
    var self = this;
    var sel = this.q(".forge-project");
    api("GET", "projects").then(function (r) {
      var cur = sel.value || self.pendingProject || "";
      sel.innerHTML = "<option value=''>(choose)</option>";
      r.projects.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        o.title = p.path;
        sel.appendChild(o);
      });
      sel.value = cur;
      if (sel.value) self.loadAssets_();
    });
  };

  ns.ForgeController.prototype.loadAssets_ = function () {
    var self = this;
    var pid = this.q(".forge-project").value;
    state.prefs.project = pid;
    savePrefs();
    this.assetFiles = [];
    this.renderAssets_();
    if (!pid) return;
    api("GET", "projects/" + pid + "/assets").then(function (r) {
      self.assetFiles = r.files;
      self.renderAssets_();
    });
  };

  ns.ForgeController.prototype.renderAssets_ = function () {
    var pid = this.q(".forge-project").value;
    var f = (this.q(".forge-asset-filter").value || "").toLowerCase();
    var files = (this.assetFiles || []).filter(function (x) {
      return !f || x.path.toLowerCase().indexOf(f) >= 0;
    });
    this.assetsEl.innerHTML = files
      .slice(0, 80)
      .map(function (x) {
        var src = "/api/projects/" + pid + "/file?path=" + encodeURIComponent(x.path);
        return (
          "<div class='forge-thumb' title='" + x.path + " (" + x.width + "×" + x.height + ")'>" +
          "<img data-asset='" + encodeURIComponent(x.path) + "' src='" + src + "'/></div>"
        );
      })
      .join("") +
      (files.length > 80 ? "<p class='forge-help'>" + files.length + " files; filter to narrow</p>" : "");
  };

  ns.ForgeController.prototype.onAssetClick_ = function (evt) {
    var rel = evt.target.getAttribute("data-asset");
    if (!rel) return;
    var pid = this.q(".forge-project").value;
    var path = decodeURIComponent(rel);
    applyImage(
      "/api/projects/" + pid + "/file?path=" + rel,
      "new",
      path.split("/").pop().replace(/\.png$/, "")
    ).then(function () {
      notify("Opened " + path + " (a copy; the project file is not modified)");
    });
  };

  ns.ForgeController.prototype.onAddProject_ = function () {
    var self = this;
    var path = this.q(".forge-project-path").value.trim();
    if (!path) return;
    api("POST", "projects/add", { path: path })
      .then(function (p) {
        self.pendingProject = p.id;
        self.q(".forge-project").value = "";
        self.loadProjects_();
        notify("Added project " + p.name);
      })
      .catch(function (e) {
        notify("Could not add: " + e.message);
      });
  };

  ns.ForgeController.prototype.onLearn_ = function () {
    var self = this;
    var pid = this.q(".forge-project").value;
    if (!pid) {
      notify("Choose a project first");
      return;
    }
    state.log = ["learning style from " + pid + "…"];
    api("POST", "projects/learn", { project: pid })
      .then(function (r) {
        state.log = [
          "style profile '" + r.profile + "' ready: " + r.colors + " colours, typical " + r.size.join("×"),
          r.style,
          "references: " + r.references.join(", "),
          "Pick it under Create → Style."
        ];
        state.prefs.profile = r.profile;
        savePrefs();
        var sel = self.q(".forge-profile");
        if (!sel.querySelector("option[value='" + r.profile + "']")) {
          var o = document.createElement("option");
          o.value = r.profile;
          o.textContent = r.profile;
          sel.appendChild(o);
        }
        sel.value = r.profile;
      })
      .catch(function (e) {
        state.log.push("error: " + e.message);
      });
  };

  ns.ForgeController.prototype.onLibraryClick_ = function (evt) {
    var id = evt.target.getAttribute("data-lib");
    if (id) {
      applyImage("/api/library/" + id + "/sprite.png", "new", id);
    }
  };

  ns.ForgeController.prototype.render_ = function () {
    if (!this.logEl) return;
    this.logEl.textContent = state.log.join("\n") + (state.busy ? "\n…" : "");
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.q(".forge-generate").disabled = state.busy;
    this.q(".forge-refine").disabled = state.busy;
    var html = state.results
      .map(function (s, i) {
        var warn = s.qa && s.qa.warnings && s.qa.warnings.length
          ? " · " + s.qa.warnings.length + " QA note(s)"
          : "";
        return (
          "<div class='forge-thumb' title='Click to open this version'>" +
          "<img data-step='" + i + "' src='" + s.png + "'/>" +
          "<span>" + s.kind + warn + "</span></div>"
        );
      })
      .join("");
    if (this.resultsEl.getAttribute("data-html") !== String(html.length)) {
      this.resultsEl.innerHTML = html;
      this.resultsEl.setAttribute("data-html", String(html.length));
    }
  };
})();
