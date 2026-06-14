#!/usr/bin/env node
// Ensure node-pty's spawn-helper binaries are executable on macOS.
// npm installs prebuilt binaries without the executable bit, which causes
// every terminal spawn to fail with "posix_spawnp failed".
import { chmodSync, existsSync } from "fs";
import { join } from "path";

if (process.platform !== "darwin") process.exit(0);

const helpers = [
  join("node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper"),
  join("node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
];

for (const p of helpers) {
  if (existsSync(p)) {
    chmodSync(p, 0o755);
    console.log(`postinstall: chmod +x ${p}`);
  }
}
