#!/usr/bin/env node

/**
 * Build script for Zotero Research Assistant plugin.
 *
 * In dev mode (--dev), copies files to the Zotero profile for live reload.
 * In production mode, creates a minified build ready for packaging.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADDON = join(ROOT, "addon");
const BUILD = join(ROOT, "build");

const isDev = process.argv.includes("--dev");

async function build() {
  console.log(`Building Zotero Research Assistant (${isDev ? "dev" : "production"})...`);

  // Create build directory
  mkdirSync(BUILD, { recursive: true });

  // Copy addon files to build
  cpSync(ADDON, BUILD, { recursive: true });

  // Read manifest and update version if needed
  const manifest = JSON.parse(readFileSync(join(BUILD, "manifest.json"), "utf-8"));
  console.log(`  Version: ${manifest.version}`);
  console.log(`  ID: ${manifest.applications.zotero.id}`);

  if (isDev) {
    console.log("\nDev build complete. To install in Zotero:");
    console.log("  1. Find your Zotero profile directory");
    console.log("  2. Create a file in extensions/ named:");
    console.log(`     ${manifest.applications.zotero.id}`);
    console.log(`  3. Put the path to ${BUILD} in that file`);
    console.log("  4. Restart Zotero");
  }

  console.log("\nBuild output:", BUILD);
}

build().catch((e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
