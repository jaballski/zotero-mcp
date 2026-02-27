/* global Zotero, ZoteroPane, Components, Services */

/**
 * Zotero Research Assistant - Main Plugin Module
 *
 * Provides semantic search and AI-powered research assistant capabilities
 * within Zotero, communicating with a local Python backend (zotero-mcp).
 *
 * Architecture:
 *   1. Registers HTTP endpoints on Zotero's built-in connector server (port 23119)
 *      so external tools (MCP clients, scripts) can access search/chat when Zotero is open
 *   2. Auto-spawns the Python backend (zotero-mcp plugin-serve) as a child process
 *      on plugin startup, kills it on shutdown - no manual server management needed
 *   3. Plugin UI talks to the Python backend via localhost HTTP
 */
Zotero.ZoteroResearchAssistant = {
  rootURI: null,
  version: null,
  _initialized: false,
  _notifierID: null,
  _windows: new Set(),
  _backend: null,
  _backendProcess: null,
  _backendPort: 9090,
  _registeredEndpoints: [],

  // ─── Lifecycle ──────────────────────────────────────────────

  async init({ id, version, rootURI }) {
    if (this._initialized) return;
    this.rootURI = rootURI;
    this.version = version;

    Zotero.debug("[ZRA] Initializing Research Assistant v" + version);

    this._backendPort = this._getPref("backend.port", 9090);

    // 1. Register HTTP endpoints on Zotero's built-in server (port 23119)
    this._registerHTTPEndpoints();

    // 2. Auto-start the Python backend process
    await this._startBackendProcess();

    // 3. Initialize the backend HTTP client (talks to our Python process)
    this._backend = new ZRABackendClient(this._getBackendURL());

    // 4. Register notifier to watch for library changes
    this._notifierID = Zotero.Notifier.registerObserver(
      this._notifierObserver,
      ["item"],
      "ZoteroResearchAssistant"
    );

    this._initialized = true;
    Zotero.debug("[ZRA] Initialization complete");
  },

  onMainWindowLoad(window) {
    this._windows.add(window);
    this._addUI(window);
  },

  onMainWindowUnload(window) {
    this._removeUI(window);
    this._windows.delete(window);
  },

  shutdown() {
    Zotero.debug("[ZRA] Shutting down");

    // Stop the Python backend process
    this._stopBackendProcess();

    // Unregister HTTP endpoints
    this._unregisterHTTPEndpoints();

    // Unregister notifier
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }

    // Clean up all windows
    for (const window of this._windows) {
      this._removeUI(window);
    }
    this._windows.clear();
    this._initialized = false;
  },

  // ═══════════════════════════════════════════════════════════════
  // HTTP ENDPOINTS ON ZOTERO'S BUILT-IN SERVER (port 23119)
  //
  // These endpoints are available whenever Zotero is running.
  // External tools can call:
  //   http://127.0.0.1:23119/zra/status
  //   http://127.0.0.1:23119/zra/search  (POST)
  //   http://127.0.0.1:23119/zra/chat    (POST)
  //   etc.
  // ═══════════════════════════════════════════════════════════════

  _registerHTTPEndpoints() {
    Zotero.debug("[ZRA] Registering HTTP endpoints on Zotero connector server");

    const self = this;

    // ─── /zra/status ─────────────────────────────────────────
    this._registerEndpoint("/zra/status", {
      supportedMethods: ["GET"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const backendURL = self._getBackendURL();
          let backendStatus = "unknown";
          try {
            const resp = await fetch(`${backendURL}/api/health`);
            if (resp.ok) backendStatus = "running";
            else backendStatus = "error";
          } catch {
            backendStatus = "not_running";
          }

          sendResponseCallback(200, "application/json", JSON.stringify({
            plugin_version: self.version,
            backend_status: backendStatus,
            backend_url: backendURL,
            backend_pid: self._backendProcess ? "running" : null,
            endpoints: [
              "GET  /zra/status",
              "POST /zra/search",
              "POST /zra/chat",
              "POST /zra/index/update",
              "POST /zra/similar",
              "POST /zra/summarize",
            ],
          }));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/search ─────────────────────────────────────────
    this._registerEndpoint("/zra/search", {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const body = typeof data === "string" ? JSON.parse(data) : data;
          const resp = await self._proxyToBackend("/api/search", body);
          sendResponseCallback(200, "application/json", JSON.stringify(resp));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/chat ───────────────────────────────────────────
    this._registerEndpoint("/zra/chat", {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const body = typeof data === "string" ? JSON.parse(data) : data;
          const resp = await self._proxyToBackend("/api/chat", body);
          sendResponseCallback(200, "application/json", JSON.stringify(resp));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/index/update ───────────────────────────────────
    this._registerEndpoint("/zra/index/update", {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const body = typeof data === "string" ? JSON.parse(data) : data;
          const resp = await self._proxyToBackend("/api/index/update", body);
          sendResponseCallback(200, "application/json", JSON.stringify(resp));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/similar ────────────────────────────────────────
    this._registerEndpoint("/zra/similar", {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const body = typeof data === "string" ? JSON.parse(data) : data;
          const resp = await self._proxyToBackend("/api/similar", body);
          sendResponseCallback(200, "application/json", JSON.stringify(resp));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/summarize ──────────────────────────────────────
    this._registerEndpoint("/zra/summarize", {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const body = typeof data === "string" ? JSON.parse(data) : data;
          const resp = await self._proxyToBackend("/api/summarize", body);
          sendResponseCallback(200, "application/json", JSON.stringify(resp));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message }));
        }
      },
    });

    // ─── /zra/index/status (GET - lightweight polling) ───────
    this._registerEndpoint("/zra/index/status", {
      supportedMethods: ["GET"],
      supportedDataTypes: ["application/json"],
      async init(data, sendResponseCallback) {
        try {
          const resp = await fetch(`${self._getBackendURL()}/api/index/status`);
          const body = await resp.json();
          sendResponseCallback(200, "application/json", JSON.stringify(body));
        } catch (e) {
          sendResponseCallback(500, "application/json",
            JSON.stringify({ error: e.message, state: "backend_unavailable" }));
        }
      },
    });

    Zotero.debug(`[ZRA] Registered ${this._registeredEndpoints.length} HTTP endpoints`);
  },

  _registerEndpoint(path, handler) {
    // Zotero's server endpoint registration pattern:
    // Zotero.Server.Endpoints[path] = constructor; prototype has init() etc.
    const EndpointConstructor = function () {};
    EndpointConstructor.prototype = handler;
    Zotero.Server.Endpoints[path] = EndpointConstructor;
    this._registeredEndpoints.push(path);
    Zotero.debug(`[ZRA] Registered endpoint: ${path}`);
  },

  _unregisterHTTPEndpoints() {
    for (const path of this._registeredEndpoints) {
      delete Zotero.Server.Endpoints[path];
      Zotero.debug(`[ZRA] Unregistered endpoint: ${path}`);
    }
    this._registeredEndpoints = [];
  },

  async _proxyToBackend(apiPath, body) {
    const url = `${this._getBackendURL()}${apiPath}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Backend error (${response.status}): ${text}`);
    }

    return await response.json();
  },

  // ═══════════════════════════════════════════════════════════════
  // PYTHON BACKEND PROCESS MANAGEMENT
  //
  // Auto-starts `zotero-mcp plugin-serve` when the plugin loads,
  // auto-kills it when the plugin shuts down or Zotero closes.
  // ═══════════════════════════════════════════════════════════════

  async _startBackendProcess() {
    if (!this._getPref("backend.autoStart", true)) {
      Zotero.debug("[ZRA] Backend auto-start disabled in preferences");
      return;
    }

    const port = this._backendPort;

    // Check if backend is already running (maybe from a previous session or manual start)
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (resp.ok) {
        Zotero.debug(`[ZRA] Backend already running on port ${port}`);
        return;
      }
    } catch {
      // Not running - we'll start it
    }

    Zotero.debug("[ZRA] Starting Python backend process...");

    try {
      // Find the zotero-mcp executable
      const command = this._findBackendCommand();
      if (!command) {
        Zotero.debug("[ZRA] Could not find zotero-mcp command. Backend not started.");
        Zotero.debug("[ZRA] Install it with: pip install zotero-mcp");
        return;
      }

      // Use nsIProcess to spawn the backend
      const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);

      // Determine the executable and arguments
      const isWindows = Services.appinfo.OS === "WINNT";
      let executable;
      let args;

      if (command.startsWith("/") || command.includes("\\")) {
        // Direct path to executable
        file.initWithPath(command);
        executable = file;
        args = ["plugin-serve", "--port", String(port)];
      } else {
        // Use shell to resolve command from PATH
        if (isWindows) {
          file.initWithPath("C:\\Windows\\System32\\cmd.exe");
          executable = file;
          args = ["/c", command, "plugin-serve", "--port", String(port)];
        } else {
          file.initWithPath("/bin/sh");
          executable = file;
          args = ["-c", `${command} plugin-serve --port ${port}`];
        }
      }

      const process = Components.classes["@mozilla.org/process/util;1"]
        .createInstance(Components.interfaces.nsIProcess);
      process.init(executable);

      // Run non-blocking (background process)
      process.runAsync(args, args.length);

      this._backendProcess = process;
      Zotero.debug(`[ZRA] Backend process started (port ${port})`);

      // Wait briefly, then verify it's running
      await new Promise((resolve) =>
        Zotero.setTimeout(resolve, 2000)
      );

      try {
        const healthResp = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (healthResp.ok) {
          Zotero.debug("[ZRA] Backend is healthy and responding");
        } else {
          Zotero.debug("[ZRA] Backend started but health check returned non-200");
        }
      } catch {
        Zotero.debug("[ZRA] Backend started but not yet responding. It may need more time to initialize.");
      }
    } catch (e) {
      Zotero.debug(`[ZRA] Failed to start backend: ${e.message}`);
      Zotero.debug("[ZRA] You can start it manually with: zotero-mcp plugin-serve --port " + port);
    }
  },

  _stopBackendProcess() {
    if (!this._backendProcess) return;

    Zotero.debug("[ZRA] Stopping backend process...");
    try {
      // Try graceful shutdown via HTTP
      fetch(`${this._getBackendURL()}/api/shutdown`, { method: "POST" }).catch(() => {});

      // Kill the process if it's still running
      if (this._backendProcess.isRunning) {
        this._backendProcess.kill();
        Zotero.debug("[ZRA] Backend process killed");
      }
    } catch (e) {
      Zotero.debug(`[ZRA] Error stopping backend: ${e.message}`);
    }
    this._backendProcess = null;
  },

  _findBackendCommand() {
    // Strategy: try multiple ways to find zotero-mcp
    const isWindows = Services.appinfo.OS === "WINNT";

    // 1. Check preference for custom path
    const customPath = this._getPref("backend.command", "");
    if (customPath) return customPath;

    // 2. Try common locations
    const candidates = isWindows
      ? [
          "zotero-mcp",
          "zotero-mcp.exe",
        ]
      : [
          "zotero-mcp",
          "/usr/local/bin/zotero-mcp",
          "/usr/bin/zotero-mcp",
        ];

    // For non-Windows, also check common Python environment locations
    if (!isWindows) {
      const home = Components.classes["@mozilla.org/file/directory_service;1"]
        .getService(Components.interfaces.nsIProperties)
        .get("Home", Components.interfaces.nsIFile).path;

      candidates.push(
        `${home}/.local/bin/zotero-mcp`,
        `${home}/.cargo/bin/zotero-mcp`, // uvx
      );

      // Also try using python -m
      candidates.push("python3 -m zotero_mcp.cli");
      candidates.push("python -m zotero_mcp.cli");
    }

    // Try to verify each candidate exists
    for (const candidate of candidates) {
      try {
        if (candidate.includes(" ")) {
          // It's a compound command (e.g., "python3 -m zotero_mcp.cli")
          // We'll use it through the shell, just return it
          return candidate;
        }

        const file = Components.classes["@mozilla.org/file/local;1"]
          .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(candidate);
        if (file.exists() && file.isExecutable()) {
          return candidate;
        }
      } catch {
        // Path may not be absolute or file doesn't exist, try next
      }
    }

    // Fallback: just use the name and let the shell resolve it
    return "zotero-mcp";
  },

  // ─── UI Management ─────────────────────────────────────────

  _addUI(window) {
    const doc = window.document;

    // 1. Add semantic search panel to the item pane
    this._addSearchPanel(doc);

    // 2. Add AI Research Assistant tab to the right pane
    this._addResearchTab(doc);

    // 3. Add toolbar button
    this._addToolbarButton(doc);

    // 4. Add context menu items
    this._addContextMenu(doc);

    // 5. Start polling for indexing status
    this._startIndexStatusPolling(doc);

    Zotero.debug("[ZRA] UI elements added to window");
  },

  _removeUI(window) {
    const doc = window.document;

    // Stop polling
    if (this._indexPollTimer) {
      clearInterval(this._indexPollTimer);
      this._indexPollTimer = null;
    }

    // Remove all elements we added (identified by class)
    const elements = doc.querySelectorAll(".zra-element");
    for (const el of elements) {
      el.remove();
    }
    Zotero.debug("[ZRA] UI elements removed from window");
  },

  // ─── Index Status Polling & Progress UI ─────────────────────

  _indexPollTimer: null,

  _startIndexStatusPolling(doc) {
    // Poll immediately, then every 3 seconds while indexing, every 30s otherwise
    this._pollIndexStatus(doc);

    this._indexPollTimer = setInterval(() => {
      this._pollIndexStatus(doc);
    }, 3000);
  },

  async _pollIndexStatus(doc) {
    try {
      const resp = await fetch(`${this._getBackendURL()}/api/index/status`);
      if (!resp.ok) return;

      const status = await resp.json();
      this._updateIndexUI(doc, status);

      // Slow down polling when not indexing
      if (status.state !== "indexing" && this._indexPollTimer) {
        clearInterval(this._indexPollTimer);
        this._indexPollTimer = setInterval(() => {
          this._pollIndexStatus(doc);
        }, 30000);
      }
      // Speed up polling when indexing
      if (status.state === "indexing" && this._indexPollTimer) {
        clearInterval(this._indexPollTimer);
        this._indexPollTimer = setInterval(() => {
          this._pollIndexStatus(doc);
        }, 2000);
      }
    } catch {
      // Backend not ready yet - update UI to show that
      this._updateIndexUI(doc, {
        state: "backend_unavailable",
        document_count: 0,
        index_ready: false,
        message: "Waiting for backend to start...",
      });
    }
  },

  _updateIndexUI(doc, status) {
    const banner = doc.getElementById("zra-index-banner");
    const progressBar = doc.getElementById("zra-index-progress");
    const progressLabel = doc.getElementById("zra-index-progress-label");
    const statusLabel = doc.getElementById("zra-search-status-label");
    const indexBtn = doc.getElementById("zra-index-btn");

    if (!banner) return;

    const state = status.state || "idle";
    const docCount = status.document_count || 0;
    const progress = status.progress || 0;
    const message = status.message || "";

    if (state === "indexing") {
      // Show progress banner
      banner.hidden = false;
      banner.style.backgroundColor = "var(--color-accent10, #e3f2fd)";
      banner.style.borderColor = "var(--color-accent, #1976d2)";

      if (progressBar) {
        progressBar.hidden = false;
        progressBar.value = progress;
        progressBar.max = 100;
      }

      const displayMsg = status.total > 0
        ? `Indexing: ${status.processed}/${status.total} items (${progress}%)`
        : message || "Building search index...";

      if (progressLabel) progressLabel.setAttribute("value", displayMsg);
      if (statusLabel) statusLabel.setAttribute("value", displayMsg);
      if (indexBtn) indexBtn.disabled = true;

    } else if (state === "complete" && docCount > 0) {
      // Index is ready
      banner.hidden = true;
      if (progressBar) progressBar.hidden = true;
      if (statusLabel) {
        statusLabel.setAttribute("value", `Index ready: ${docCount} items`);
      }
      if (indexBtn) indexBtn.disabled = false;

    } else if (state === "error") {
      banner.hidden = false;
      banner.style.backgroundColor = "var(--accent-red10, #fce4ec)";
      banner.style.borderColor = "var(--accent-red, #d32f2f)";
      if (progressBar) progressBar.hidden = true;
      if (progressLabel) {
        progressLabel.setAttribute("value", `Indexing error: ${status.error || "unknown"}`);
      }
      if (indexBtn) indexBtn.disabled = false;

    } else if (docCount === 0 && state !== "indexing") {
      // Empty index - show banner prompting to build
      banner.hidden = false;
      banner.style.backgroundColor = "var(--color-accent10, #fff3e0)";
      banner.style.borderColor = "var(--color-accent, #f57c00)";
      if (progressBar) progressBar.hidden = true;
      if (progressLabel) {
        progressLabel.setAttribute("value",
          state === "backend_unavailable"
            ? "Starting backend..."
            : "No search index yet. Click 'Update Index' or wait for auto-build."
        );
      }
      if (indexBtn) indexBtn.disabled = state === "backend_unavailable";

    } else {
      // Normal idle state with populated index
      banner.hidden = true;
      if (progressBar) progressBar.hidden = true;
      if (statusLabel) {
        statusLabel.setAttribute("value", `Ready (${docCount} items indexed)`);
      }
      if (indexBtn) indexBtn.disabled = false;
    }
  },

  // ─── Semantic Search Panel ─────────────────────────────────

  _addSearchPanel(doc) {
    // Create search panel container
    const panel = doc.createXULElement("vbox");
    panel.id = "zra-search-panel";
    panel.className = "zra-element";
    panel.setAttribute("flex", "1");

    // Search header with mode toggle
    const header = doc.createXULElement("hbox");
    header.className = "zra-search-header";
    header.setAttribute("align", "center");
    header.style.padding = "6px 8px";
    header.style.borderBottom = "1px solid var(--fill-quinary)";

    // Search input
    const searchBox = doc.createXULElement("search-textbox");
    searchBox.id = "zra-search-input";
    searchBox.setAttribute("placeholder", "Semantic search your library...");
    searchBox.setAttribute("flex", "1");
    searchBox.setAttribute("type", "search");
    searchBox.addEventListener("command", () => this._onSearch(doc));
    header.appendChild(searchBox);

    // Search mode dropdown
    const modeMenu = doc.createXULElement("menulist");
    modeMenu.id = "zra-search-mode";
    modeMenu.style.marginLeft = "6px";
    modeMenu.style.maxWidth = "110px";

    const modePopup = doc.createXULElement("menupopup");
    for (const [value, label] of [
      ["hybrid", "Hybrid"],
      ["semantic", "Semantic"],
      ["keyword", "Keyword"],
    ]) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("value", value);
      item.setAttribute("label", label);
      modePopup.appendChild(item);
    }
    modeMenu.appendChild(modePopup);
    modeMenu.value = this._getPref("search.mode", "hybrid");
    header.appendChild(modeMenu);

    panel.appendChild(header);

    // Index status banner (shown when index is empty or building)
    const indexBanner = doc.createXULElement("vbox");
    indexBanner.id = "zra-index-banner";
    indexBanner.hidden = true; // Hidden by default, shown by _updateIndexUI
    indexBanner.style.padding = "8px 10px";
    indexBanner.style.margin = "4px";
    indexBanner.style.borderRadius = "6px";
    indexBanner.style.border = "1px solid var(--color-accent, #1976d2)";
    indexBanner.style.backgroundColor = "var(--color-accent10, #e3f2fd)";
    indexBanner.style.fontSize = "12px";

    const progressLabel = doc.createXULElement("label");
    progressLabel.id = "zra-index-progress-label";
    progressLabel.setAttribute("value", "Checking index status...");
    progressLabel.style.fontWeight = "500";
    indexBanner.appendChild(progressLabel);

    // Progress bar
    const progressBar = doc.createXULElement("html:progress");
    progressBar.id = "zra-index-progress";
    progressBar.hidden = true;
    progressBar.setAttribute("max", "100");
    progressBar.setAttribute("value", "0");
    progressBar.style.width = "100%";
    progressBar.style.height = "6px";
    progressBar.style.marginTop = "6px";
    progressBar.style.borderRadius = "3px";
    indexBanner.appendChild(progressBar);

    panel.appendChild(indexBanner);

    // Search results container
    const results = doc.createXULElement("vbox");
    results.id = "zra-search-results";
    results.setAttribute("flex", "1");
    results.style.overflow = "auto";
    results.style.padding = "4px";
    panel.appendChild(results);

    // Status bar
    const status = doc.createXULElement("hbox");
    status.id = "zra-search-status";
    status.className = "zra-search-status";
    status.style.padding = "4px 8px";
    status.style.borderTop = "1px solid var(--fill-quinary)";
    status.style.fontSize = "11px";
    status.style.color = "var(--fill-secondary)";

    const statusLabel = doc.createXULElement("label");
    statusLabel.id = "zra-search-status-label";
    statusLabel.setAttribute("value", "Ready");
    status.appendChild(statusLabel);

    const indexBtn = doc.createXULElement("button");
    indexBtn.id = "zra-index-btn";
    indexBtn.setAttribute("label", "Update Index");
    indexBtn.style.marginLeft = "auto";
    indexBtn.style.fontSize = "11px";
    indexBtn.addEventListener("command", () => this._onUpdateIndex(doc));
    status.appendChild(indexBtn);

    panel.appendChild(status);

    // Insert as a new tab panel in the collections pane area
    // We'll add it as a splitter + panel below the main content
    const mainContainer =
      doc.getElementById("zotero-items-pane") ||
      doc.getElementById("zotero-view-item");
    if (mainContainer && mainContainer.parentElement) {
      const splitter = doc.createXULElement("splitter");
      splitter.id = "zra-search-splitter";
      splitter.className = "zra-element";
      splitter.setAttribute("orient", "vertical");
      splitter.setAttribute("collapse", "after");
      splitter.style.height = "6px";
      splitter.style.cursor = "ns-resize";
      splitter.style.borderTop = "1px solid var(--fill-quinary)";

      mainContainer.parentElement.appendChild(splitter);
      mainContainer.parentElement.appendChild(panel);
    }
  },

  // ─── Research Assistant Tab ────────────────────────────────

  _addResearchTab(doc) {
    // Create the research assistant as a tab panel in the item pane
    const tabContainer = doc.getElementById("zotero-editpane-tabs");
    const tabPanelContainer = doc.getElementById("zotero-editpane-tab-box") ||
      doc.getElementById("zotero-view-item");

    if (!tabContainer || !tabPanelContainer) {
      Zotero.debug("[ZRA] Could not find tab containers for research panel");
      return;
    }

    // Add tab
    const tab = doc.createXULElement("tab");
    tab.id = "zra-research-tab";
    tab.className = "zra-element";
    tab.setAttribute("label", "AI Assistant");
    tabContainer.appendChild(tab);

    // Add tab panel
    const tabPanel = doc.createXULElement("tabpanel");
    tabPanel.id = "zra-research-panel";
    tabPanel.className = "zra-element";

    // Chat container
    const chatContainer = doc.createXULElement("vbox");
    chatContainer.setAttribute("flex", "1");

    // Context selector
    const contextBar = doc.createXULElement("hbox");
    contextBar.setAttribute("align", "center");
    contextBar.style.padding = "6px 8px";
    contextBar.style.borderBottom = "1px solid var(--fill-quinary)";
    contextBar.style.backgroundColor = "var(--material-background)";

    const contextLabel = doc.createXULElement("label");
    contextLabel.setAttribute("value", "Context:");
    contextLabel.style.marginRight = "6px";
    contextLabel.style.fontWeight = "600";
    contextBar.appendChild(contextLabel);

    const contextValue = doc.createXULElement("label");
    contextValue.id = "zra-context-label";
    contextValue.setAttribute("value", "Selected items (0)");
    contextValue.setAttribute("flex", "1");
    contextBar.appendChild(contextValue);

    const contextBtn = doc.createXULElement("button");
    contextBtn.setAttribute("label", "Use Collection");
    contextBtn.addEventListener("command", () =>
      this._setContextToCollection(doc)
    );
    contextBar.appendChild(contextBtn);

    chatContainer.appendChild(contextBar);

    // Chat messages area
    const chatMessages = doc.createXULElement("vbox");
    chatMessages.id = "zra-chat-messages";
    chatMessages.setAttribute("flex", "1");
    chatMessages.style.overflow = "auto";
    chatMessages.style.padding = "8px";
    chatMessages.style.gap = "8px";

    // Welcome message
    const welcome = doc.createXULElement("vbox");
    welcome.className = "zra-chat-message zra-chat-assistant";
    welcome.style.padding = "10px";
    welcome.style.borderRadius = "8px";
    welcome.style.backgroundColor = "var(--material-background)";
    welcome.style.border = "1px solid var(--fill-quinary)";

    const welcomeText = doc.createXULElement("description");
    welcomeText.textContent =
      "Welcome! I'm your research assistant. Select papers or a collection as context, then ask questions about your research. I'll provide source-grounded answers with citations.";
    welcomeText.style.whiteSpace = "pre-wrap";
    welcome.appendChild(welcomeText);
    chatMessages.appendChild(welcome);

    chatContainer.appendChild(chatMessages);

    // Chat input area
    const inputBar = doc.createXULElement("hbox");
    inputBar.setAttribute("align", "center");
    inputBar.style.padding = "8px";
    inputBar.style.borderTop = "1px solid var(--fill-quinary)";
    inputBar.style.gap = "6px";

    const chatInput = doc.createXULElement("textbox");
    chatInput.id = "zra-chat-input";
    chatInput.setAttribute("placeholder", "Ask about your research...");
    chatInput.setAttribute("flex", "1");
    chatInput.setAttribute("multiline", "true");
    chatInput.setAttribute("rows", "2");
    chatInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._onChatSend(doc);
      }
    });
    inputBar.appendChild(chatInput);

    const sendBtn = doc.createXULElement("button");
    sendBtn.id = "zra-chat-send";
    sendBtn.setAttribute("label", "Send");
    sendBtn.addEventListener("command", () => this._onChatSend(doc));
    inputBar.appendChild(sendBtn);

    chatContainer.appendChild(inputBar);

    // LLM provider selector
    const providerBar = doc.createXULElement("hbox");
    providerBar.setAttribute("align", "center");
    providerBar.style.padding = "4px 8px";
    providerBar.style.borderTop = "1px solid var(--fill-quinary)";
    providerBar.style.fontSize = "11px";

    const providerLabel = doc.createXULElement("label");
    providerLabel.setAttribute("value", "Provider:");
    providerLabel.style.marginRight = "4px";
    providerBar.appendChild(providerLabel);

    const providerMenu = doc.createXULElement("menulist");
    providerMenu.id = "zra-llm-provider";
    providerMenu.style.maxWidth = "140px";

    const providerPopup = doc.createXULElement("menupopup");
    for (const [value, label] of [
      ["anthropic", "Claude"],
      ["openai", "OpenAI"],
      ["google", "Gemini"],
      ["ollama", "Ollama (Local)"],
    ]) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("value", value);
      item.setAttribute("label", label);
      providerPopup.appendChild(item);
    }
    providerMenu.appendChild(providerPopup);
    providerBar.appendChild(providerMenu);

    chatContainer.appendChild(providerBar);

    tabPanel.appendChild(chatContainer);

    // Find the tabpanels element and append
    const tabPanels = tabPanelContainer.querySelector("tabpanels");
    if (tabPanels) {
      tabPanels.appendChild(tabPanel);
    }
  },

  // ─── Toolbar & Context Menu ────────────────────────────────

  _addToolbarButton(doc) {
    // Add button to Zotero toolbar
    const toolbar = doc.getElementById("zotero-items-toolbar");
    if (!toolbar) return;

    const btn = doc.createXULElement("toolbarbutton");
    btn.id = "zra-toolbar-button";
    btn.className = "zra-element zotero-tb-button";
    btn.setAttribute("tooltiptext", "Research Assistant - Semantic Search");
    btn.setAttribute("label", "AI Search");
    btn.addEventListener("command", () => this._toggleSearchPanel(doc));
    toolbar.appendChild(btn);
  },

  _addContextMenu(doc) {
    const menu = doc.getElementById("zotero-itemmenu");
    if (!menu) return;

    const separator = doc.createXULElement("menuseparator");
    separator.className = "zra-element";
    menu.appendChild(separator);

    const menuItem = doc.createXULElement("menuitem");
    menuItem.className = "zra-element";
    menuItem.setAttribute("label", "Ask AI about this item...");
    menuItem.addEventListener("command", () => {
      this._askAboutSelected(doc);
    });
    menu.appendChild(menuItem);

    const similarItem = doc.createXULElement("menuitem");
    similarItem.className = "zra-element";
    similarItem.setAttribute("label", "Find similar items");
    similarItem.addEventListener("command", () => {
      this._findSimilar(doc);
    });
    menu.appendChild(similarItem);
  },

  // ─── Search Operations ─────────────────────────────────────

  async _onSearch(doc) {
    const input = doc.getElementById("zra-search-input");
    const modeMenu = doc.getElementById("zra-search-mode");
    const resultsContainer = doc.getElementById("zra-search-results");
    const statusLabel = doc.getElementById("zra-search-status-label");

    const query = input?.value?.trim();
    if (!query) return;

    const mode = modeMenu?.value || "hybrid";
    statusLabel.setAttribute("value", "Searching...");

    try {
      const results = await this._backend.search(query, mode, 20);
      this._renderSearchResults(doc, results, query);
      statusLabel.setAttribute(
        "value",
        `Found ${results.length} results (${mode} mode)`
      );
    } catch (e) {
      Zotero.debug(`[ZRA] Search error: ${e.message}`);
      statusLabel.setAttribute("value", `Error: ${e.message}`);
      this._renderSearchError(doc, e);
    }
  },

  _renderSearchResults(doc, results, query) {
    const container = doc.getElementById("zra-search-results");
    if (!container) return;

    // Clear previous results
    while (container.firstChild) {
      container.firstChild.remove();
    }

    if (!results || results.length === 0) {
      const empty = doc.createXULElement("description");
      empty.textContent = `No results found for "${query}"`;
      empty.style.padding = "16px";
      empty.style.textAlign = "center";
      empty.style.color = "var(--fill-secondary)";
      container.appendChild(empty);
      return;
    }

    for (const result of results) {
      const row = doc.createXULElement("vbox");
      row.className = "zra-search-result";
      row.style.padding = "8px";
      row.style.margin = "2px 0";
      row.style.borderRadius = "4px";
      row.style.cursor = "pointer";
      row.style.border = "1px solid var(--fill-quinary)";

      row.addEventListener("mouseover", () => {
        row.style.backgroundColor = "var(--color-accent10)";
      });
      row.addEventListener("mouseout", () => {
        row.style.backgroundColor = "";
      });

      // Title + score
      const titleRow = doc.createXULElement("hbox");
      titleRow.setAttribute("align", "center");

      const title = doc.createXULElement("label");
      title.setAttribute("value", result.title || "Untitled");
      title.style.fontWeight = "600";
      title.style.flex = "1";
      title.setAttribute("crop", "end");
      titleRow.appendChild(title);

      if (result.score !== undefined) {
        const score = doc.createXULElement("label");
        score.setAttribute(
          "value",
          `★ ${(result.score * 100).toFixed(0)}%`
        );
        score.style.color = "var(--color-accent)";
        score.style.fontSize = "11px";
        score.style.marginLeft = "8px";
        titleRow.appendChild(score);
      }

      row.appendChild(titleRow);

      // Authors + year
      if (result.creators || result.date) {
        const meta = doc.createXULElement("label");
        const parts = [];
        if (result.creators) parts.push(result.creators);
        if (result.date) parts.push(result.date);
        meta.setAttribute("value", parts.join(" · "));
        meta.style.fontSize = "11px";
        meta.style.color = "var(--fill-secondary)";
        row.appendChild(meta);
      }

      // Matching passage preview
      if (result.passage) {
        const passage = doc.createXULElement("description");
        passage.textContent = result.passage;
        passage.style.fontSize = "12px";
        passage.style.marginTop = "4px";
        passage.style.color = "var(--fill-tertiary)";
        passage.style.whiteSpace = "pre-wrap";
        passage.style.maxHeight = "3em";
        passage.style.overflow = "hidden";
        row.appendChild(passage);
      }

      // Click to select item in Zotero
      if (result.item_key) {
        row.addEventListener("click", () => {
          this._selectItem(result.item_key);
        });
      }

      container.appendChild(row);
    }
  },

  _renderSearchError(doc, error) {
    const container = doc.getElementById("zra-search-results");
    if (!container) return;

    while (container.firstChild) {
      container.firstChild.remove();
    }

    const errorBox = doc.createXULElement("vbox");
    errorBox.style.padding = "16px";
    errorBox.style.textAlign = "center";

    const msg = doc.createXULElement("description");
    msg.textContent = `Could not connect to backend: ${error.message}`;
    msg.style.color = "var(--accent-red)";
    errorBox.appendChild(msg);

    const hint = doc.createXULElement("description");
    hint.textContent =
      "The backend should auto-start with Zotero. If not, install zotero-mcp (pip install zotero-mcp) or start manually: zotero-mcp plugin-serve";
    hint.style.fontSize = "11px";
    hint.style.marginTop = "8px";
    hint.style.color = "var(--fill-secondary)";
    hint.style.whiteSpace = "pre-wrap";
    errorBox.appendChild(hint);

    container.appendChild(errorBox);
  },

  // ─── Chat Operations ───────────────────────────────────────

  async _onChatSend(doc) {
    const input = doc.getElementById("zra-chat-input");
    const query = input?.value?.trim();
    if (!query) return;

    input.value = "";

    // Add user message to chat
    this._addChatMessage(doc, query, "user");

    // Get context (selected items or collection)
    const context = this._getContext(doc);

    try {
      const response = await this._backend.chat(query, context);
      this._addChatMessage(doc, response.answer, "assistant", response.sources);
    } catch (e) {
      Zotero.debug(`[ZRA] Chat error: ${e.message}`);
      this._addChatMessage(
        doc,
        `Error: ${e.message}. Make sure the backend is running.`,
        "error"
      );
    }
  },

  _addChatMessage(doc, text, role, sources) {
    const container = doc.getElementById("zra-chat-messages");
    if (!container) return;

    const msg = doc.createXULElement("vbox");
    msg.className = `zra-chat-message zra-chat-${role}`;
    msg.style.padding = "10px";
    msg.style.borderRadius = "8px";
    msg.style.maxWidth = "90%";

    if (role === "user") {
      msg.style.alignSelf = "flex-end";
      msg.style.backgroundColor = "var(--color-accent)";
      msg.style.color = "white";
    } else if (role === "assistant") {
      msg.style.backgroundColor = "var(--material-background)";
      msg.style.border = "1px solid var(--fill-quinary)";
    } else if (role === "error") {
      msg.style.backgroundColor = "var(--accent-red10)";
      msg.style.border = "1px solid var(--accent-red)";
    }

    const textEl = doc.createXULElement("description");
    textEl.textContent = text;
    textEl.style.whiteSpace = "pre-wrap";
    msg.appendChild(textEl);

    // Add source citations
    if (sources && sources.length > 0) {
      const sourcesBox = doc.createXULElement("vbox");
      sourcesBox.style.marginTop = "8px";
      sourcesBox.style.paddingTop = "8px";
      sourcesBox.style.borderTop = "1px solid var(--fill-quinary)";

      const sourcesLabel = doc.createXULElement("label");
      sourcesLabel.setAttribute("value", "Sources:");
      sourcesLabel.style.fontWeight = "600";
      sourcesLabel.style.fontSize = "11px";
      sourcesBox.appendChild(sourcesLabel);

      for (const source of sources) {
        const sourceLink = doc.createXULElement("label");
        sourceLink.setAttribute(
          "value",
          `📄 ${source.title} ${source.location ? `(${source.location})` : ""}`
        );
        sourceLink.style.fontSize = "11px";
        sourceLink.style.cursor = "pointer";
        sourceLink.style.color = "var(--color-accent)";
        sourceLink.style.textDecoration = "underline";

        if (source.item_key) {
          sourceLink.addEventListener("click", () => {
            this._selectItem(source.item_key);
          });
        }

        sourcesBox.appendChild(sourceLink);
      }

      msg.appendChild(sourcesBox);
    }

    container.appendChild(msg);

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  },

  // ─── Context Management ────────────────────────────────────

  _getContext(doc) {
    const items = ZoteroPane.getSelectedItems();
    const contextLabel = doc.getElementById("zra-context-label");

    if (items && items.length > 0) {
      if (contextLabel) {
        contextLabel.setAttribute("value", `Selected items (${items.length})`);
      }
      return {
        type: "items",
        item_keys: items.map((item) => item.key),
      };
    }

    const collection = ZoteroPane.getSelectedCollection();
    if (collection) {
      if (contextLabel) {
        contextLabel.setAttribute("value", `Collection: ${collection.name}`);
      }
      return {
        type: "collection",
        collection_key: collection.key,
      };
    }

    return { type: "library" };
  },

  _setContextToCollection(doc) {
    const collection = ZoteroPane.getSelectedCollection();
    const contextLabel = doc.getElementById("zra-context-label");
    if (collection && contextLabel) {
      contextLabel.setAttribute("value", `Collection: ${collection.name}`);
    }
  },

  // ─── Item Operations ───────────────────────────────────────

  async _selectItem(itemKey) {
    try {
      const libraryID = Zotero.Libraries.userLibraryID;
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey
      );
      if (item) {
        await ZoteroPane.selectItem(item.id);
      }
    } catch (e) {
      Zotero.debug(`[ZRA] Error selecting item: ${e.message}`);
    }
  },

  async _askAboutSelected(doc) {
    const items = ZoteroPane.getSelectedItems();
    if (!items || items.length === 0) return;

    const titles = items.map((i) => i.getField("title")).join(", ");
    const chatInput = doc.getElementById("zra-chat-input");
    if (chatInput) {
      chatInput.value = `Summarize and explain the key findings of: ${titles}`;
    }

    // Switch to the AI tab
    this._switchToResearchTab(doc);
  },

  async _findSimilar(doc) {
    const items = ZoteroPane.getSelectedItems();
    if (!items || items.length === 0) return;

    const item = items[0];
    const title = item.getField("title");
    const searchInput = doc.getElementById("zra-search-input");
    if (searchInput) {
      searchInput.value = title;
      const modeMenu = doc.getElementById("zra-search-mode");
      if (modeMenu) modeMenu.value = "semantic";
      this._onSearch(doc);
    }
  },

  // ─── Index Operations ──────────────────────────────────────

  async _onUpdateIndex(doc) {
    const statusLabel = doc.getElementById("zra-search-status-label");
    const indexBtn = doc.getElementById("zra-index-btn");

    try {
      statusLabel.setAttribute("value", "Updating search index...");
      if (indexBtn) indexBtn.disabled = true;

      const result = await this._backend.updateIndex();
      statusLabel.setAttribute(
        "value",
        `Index updated: ${result.total_items || "?"} items indexed`
      );
    } catch (e) {
      statusLabel.setAttribute("value", `Index error: ${e.message}`);
    } finally {
      if (indexBtn) indexBtn.disabled = false;
    }
  },

  // ─── Notifier Observer ─────────────────────────────────────

  _notifierObserver: {
    notify(event, type, ids) {
      if (type === "item" && (event === "add" || event === "modify")) {
        // Auto-index new/modified items if enabled
        const autoIndex = Zotero.ZoteroResearchAssistant._getPref(
          "embedding.autoIndex",
          true
        );
        if (autoIndex) {
          Zotero.debug(
            `[ZRA] Items ${event}: ${ids.join(", ")} - queuing for indexing`
          );
          // Debounce: wait a bit for batch adds
          if (Zotero.ZoteroResearchAssistant._indexTimeout) {
            clearTimeout(Zotero.ZoteroResearchAssistant._indexTimeout);
          }
          Zotero.ZoteroResearchAssistant._indexTimeout = setTimeout(() => {
            Zotero.ZoteroResearchAssistant._backend
              .updateIndex()
              .catch((e) =>
                Zotero.debug(`[ZRA] Auto-index error: ${e.message}`)
              );
          }, 5000);
        }
      }
    },
  },

  // ─── Helpers ───────────────────────────────────────────────

  _toggleSearchPanel(doc) {
    const panel = doc.getElementById("zra-search-panel");
    const splitter = doc.getElementById("zra-search-splitter");
    if (panel) {
      const hidden = panel.hidden;
      panel.hidden = !hidden;
      if (splitter) splitter.hidden = !hidden;
      if (!hidden) {
        // Focus search input when showing
        const input = doc.getElementById("zra-search-input");
        if (input) input.focus();
      }
    }
  },

  _switchToResearchTab(doc) {
    const tabBox =
      doc.getElementById("zotero-editpane-tab-box") ||
      doc.getElementById("zotero-view-item");
    const tab = doc.getElementById("zra-research-tab");
    if (tabBox && tab) {
      const tabs = tabBox.querySelector("tabs");
      if (tabs) {
        const index = Array.from(tabs.children).indexOf(tab);
        if (index >= 0) {
          tabBox.selectedIndex = index;
        }
      }
    }
  },

  _getPref(key, defaultValue) {
    try {
      return Zotero.Prefs.get(
        `extensions.zotero-research-assistant.${key}`,
        defaultValue
      );
    } catch {
      return defaultValue;
    }
  },

  _getBackendURL() {
    const host = this._getPref("backend.host", "http://127.0.0.1");
    const port = this._getPref("backend.port", 9090);
    return `${host}:${port}`;
  },
};

// ─── Backend API Client ────────────────────────────────────────

class ZRABackendClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
  }

  async search(query, mode = "hybrid", limit = 20) {
    const response = await this._request("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, mode, limit }),
    });
    return response.results || [];
  }

  async chat(query, context) {
    const response = await this._request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ query, context }),
    });
    return response;
  }

  async updateIndex(options = {}) {
    const response = await this._request("/api/index/update", {
      method: "POST",
      body: JSON.stringify(options),
    });
    return response;
  }

  async getStatus() {
    return await this._request("/api/status");
  }

  async _request(path, options = {}) {
    const url = `${this.baseURL}${path}`;
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return await response.json();
    } catch (e) {
      if (e.message?.includes("fetch")) {
        throw new Error(
          "Backend not reachable. Start it with: zotero-mcp serve --transport streamable-http --port 9090"
        );
      }
      throw e;
    }
  }
}
