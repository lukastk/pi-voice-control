import { build } from "esbuild";
import { chmodSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

await build({
  entryPoints: [join(cwd, "client.mjs")],
  bundle: true,
  format: "esm",
  outfile: join(cwd, "dist/client.js"),
  absWorkingDir: cwd,
  nodePaths: [join(cwd, "node_modules")],
  minify: true,
});

// node-pty's spawn-helper prebuilt binary ships without execute permission
const prebuildsDir = join(cwd, "node_modules/node-pty/prebuilds");
if (existsSync(prebuildsDir)) {
  for (const dir of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, dir, "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
    }
  }
}
