import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { WaveGraphRequest } from "./protocol";
import type { WaveformTask } from "./waveform-files";
import { resolveWaveformPaths } from "./waveform-tcl";

import { instantiateParser } from "../../xschem-viewer/src/parser/wasm";

async function parse(path: string, graphs: WaveGraphRequest[]) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile())
      throw new Error("The waveform result is not a regular file");
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("The waveform file is too large");
    const bytes = readFileSync(
      join(__dirname, "assets/xschem_viewer_parser.wasm"),
    );
    const parser = await instantiateParser(
      await WebAssembly.compile(new Uint8Array(bytes)),
      (offset, destination) =>
        readSync(fd, destination, 0, destination.length, offset),
    );
    return parser.parseWaveforms(Number(stat.size), graphs);
  } finally {
    closeSync(fd);
  }
}

const task = workerData as WaveformTask;
const work =
  task.type === "resolve"
    ? resolveWaveformPaths(task.expressions, task.files, task.roots).then(
        (value) => ({ value }),
      )
    : parse(task.path, task.graphs).then((value) => ({ value }));
void work.then(
  (result) => parentPort!.postMessage(result),
  (error: unknown) =>
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : String(error),
    }),
);
