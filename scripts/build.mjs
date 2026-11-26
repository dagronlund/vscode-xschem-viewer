import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import { cp, mkdir, rm } from "node:fs/promises";
import {
  buildParser,
  writeDependencyLicenses,
} from "../../xschem-viewer/scripts/build-parser.mjs";

const renderer = new URL("../../xschem-viewer/", import.meta.url);

await rm("dist", { recursive: true, force: true });
buildParser();

await esbuild({
  entryPoints: {
    extension: "src/extension.ts",
    "waveform-worker": "src/waveform-worker.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  bundle: true,
  loader: { ".tcl": "text" },
  external: ["vscode"],
  target: "node18",
  logOverride: { "duplicate-case": "silent" },
});
await vite({
  configFile: false,
  base: "./",
  publicDir: false,
  build: {
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: "src/webview.ts",
      output: {
        entryFileNames: "assets/webview.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
await mkdir("dist/licenses/xschem-viewer", { recursive: true });
await cp(new URL("LICENSE", renderer), "dist/licenses/xschem-viewer/LICENSE");
for (const file of ["LICENSE", "license.terms"]) {
  await cp(
    new URL(`vendor/wacl/${file}`, renderer),
    `dist/licenses/xschem-viewer/wacl-${file}`,
  );
}

await writeDependencyLicenses(
  new URL("../dist/licenses/parser-dependencies/", import.meta.url),
);
