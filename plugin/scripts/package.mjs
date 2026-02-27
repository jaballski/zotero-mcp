#!/usr/bin/env node

/**
 * Package script: creates an .xpi file from the build directory.
 * An .xpi is just a ZIP file with a different extension.
 */

import { createWriteStream, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUILD = join(ROOT, "build");
const DIST = join(ROOT, "dist");

async function packageXPI() {
  if (!existsSync(BUILD)) {
    console.error("Build directory not found. Run 'npm run build' first.");
    process.exit(1);
  }

  // Dynamic import for archiver (may need to be installed)
  let archiver;
  try {
    archiver = (await import("archiver")).default;
  } catch {
    console.error("archiver not installed. Run: npm install");
    process.exit(1);
  }

  const manifest = JSON.parse(
    readFileSync(join(BUILD, "manifest.json"), "utf-8")
  );
  const name = manifest.name.toLowerCase().replace(/\s+/g, "-");
  const version = manifest.version;
  const filename = `${name}-${version}.xpi`;

  mkdirSync(DIST, { recursive: true });

  const output = createWriteStream(join(DIST, filename));
  const archive = archiver("zip", { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on("close", () => {
      console.log(`\nPackaged: dist/${filename} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(BUILD, false);
    archive.finalize();
  });
}

packageXPI().catch((e) => {
  console.error("Packaging failed:", e);
  process.exit(1);
});
