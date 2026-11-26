import { readFileSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createWacl } from "../../xschem-viewer/src/tcl/wacl.js";
import {
  evaluateWaveformPaths,
  maxTclSourceBytes,
  type RawFileOperation,
  type TclWaveformPath,
} from "../../xschem-viewer/src/waveforms/rawFileTcl";
import { contained, type WaveformFiles } from "./waveform-files";

function tclPath(path: string): string {
  return path.split(sep).join("/");
}

async function access(
  operation: RawFileOperation,
  path: string,
  directory: string,
  roots: string[],
): Promise<string | string[]> {
  const candidate = resolve(directory, path);
  const expectedExtension = operation === "source" ? ".tcl" : ".raw";
  if (
    operation !== "list" &&
    extname(candidate).toLowerCase() !== expectedExtension
  )
    throw new Error(`Expected a ${expectedExtension} file at ${candidate}`);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (
      operation === "list" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return "";
    throw error;
  }
  if (!roots.some((root) => contained(resolved, root)))
    throw new Error(`Path is outside the waveform search roots: ${candidate}`);
  switch (operation) {
    case "list": {
      const entries = await readdir(resolved, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            entry.isFile() && extname(entry.name).toLowerCase() === ".raw",
        )
        .map((entry) => entry.name);
    }
    case "source": {
      const info = await stat(resolved);
      if (!info.isFile() || info.size > maxTclSourceBytes)
        throw new Error(
          `Expected a Tcl script of at most 256 KiB at ${candidate}`,
        );
      return readFile(resolved, "utf8");
    }
    case "mtime": {
      const info = await stat(resolved);
      if (!info.isFile())
        throw new Error(`Expected a raw file at ${candidate}`);
      return String(Math.floor(info.mtimeMs / 1000));
    }
  }
}

export async function resolveWaveformPaths(
  expressions: string[],
  files: WaveformFiles,
  roots: string[],
): Promise<TclWaveformPath[]> {
  const wasm = readFileSync(join(__dirname, "assets", "wacl.wasm"));
  const interp = await createWacl(wasm, require).ready;
  const directory = dirname(files.schematic);
  return evaluateWaveformPaths(
    interp,
    expressions,
    {
      schematic: tclPath(files.schematic),
      directory: tclPath(directory),
      simulationDirectory: tclPath(files.simulationDirectory),
    },
    (operation, path) => access(operation, path, directory, roots),
  );
}
