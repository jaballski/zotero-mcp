/* global Zotero, ZoteroPane, Components, Services */

/**
 * Zotero Research Assistant - Main Plugin Module
 *
 * Provides semantic search and AI-powered research assistant capabilities
 * within Zotero, communicating with a local Python backend (zotero-mcp).
 */
Zotero.ZoteroResearchAssistant = {
  rootURI: null,
  version: null,
  _initialized: false,
  _notifierID: null,
  _windows: new Set(),
  _backend: null,

  // ─── Lifecycle ──────────────────────────────────────────────

  async init({ id, version, rootURI }) {
    if (this._initialized) return;
    this.rootURI = rootURI;
    this.version = version;

    Zotero.debug("[ZRA] Initializing Research Assistant v" + version);

    // Initialize backend client
    this._backend = new ZRABackendClient(this._getBackendURL());

    // Register notifier to watch for library changes
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

    Zotero.debug("[ZRA] UI elements added to window");
  },

  _removeUI(window) {
    const doc = window.document;
    // Remove all elements we added (identified by class)
    const elements = doc.querySelectorAll(".zra-element");
    for (const el of elements) {
      el.remove();
    }
    Zotero.debug("[ZRA] UI elements removed from window");
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
      'Make sure the backend is running: zotero-mcp serve --transport streamable-http --port 9090';
    hint.style.fontSize = "11px";
    hint.style.marginTop = "8px";
    hint.style.color = "var(--fill-secondary)";
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
