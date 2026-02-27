/* eslint-disable no-undef */
/* global ChromeUtils, Components, dump */

var ZoteroResearchAssistant;

function log(msg) {
  if (typeof dump !== "undefined") {
    dump(`[ZoteroResearchAssistant] ${msg}\n`);
  }
}

function install(data, reason) {
  log("Installed");
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  log(`Starting v${version}`);

  // Wait for Zotero to be ready
  await waitForZotero();

  // Store rootURI for resource loading
  const uri = rootURI || resourceURI.spec;

  // Load the main module
  Services.scriptloader.loadSubScript(`${uri}content/zotero-research-assistant.js`);

  ZoteroResearchAssistant = Zotero.ZoteroResearchAssistant;
  ZoteroResearchAssistant.rootURI = uri;
  ZoteroResearchAssistant.version = version;

  await ZoteroResearchAssistant.init({ id, version, rootURI: uri });
}

function onMainWindowLoad({ window }) {
  if (ZoteroResearchAssistant) {
    ZoteroResearchAssistant.onMainWindowLoad(window);
  }
}

function onMainWindowUnload({ window }) {
  if (ZoteroResearchAssistant) {
    ZoteroResearchAssistant.onMainWindowUnload(window);
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  log("Shutting down");
  if (ZoteroResearchAssistant) {
    ZoteroResearchAssistant.shutdown();
    ZoteroResearchAssistant = undefined;
  }
}

function uninstall(data, reason) {
  log("Uninstalled");
}

// Helper: wait for Zotero to be available
function waitForZotero() {
  if (typeof Zotero !== "undefined") {
    return Zotero.initializationPromise || Promise.resolve();
  }

  return new Promise((resolve) => {
    const observer = {
      observe(subject, topic) {
        if (topic === "zotero-loaded") {
          Services.obs.removeObserver(observer, "zotero-loaded");
          if (Zotero.initializationPromise) {
            Zotero.initializationPromise.then(resolve);
          } else {
            resolve();
          }
        }
      },
    };
    Services.obs.addObserver(observer, "zotero-loaded", false);
  });
}
