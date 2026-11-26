import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Worker } from "node:worker_threads";
import type { WaveGraphRequest, WaveGraphResult } from "./protocol";
import { rawFileExpression } from "../../xschem-viewer/src/waveforms/rawFile";
import type { TclWaveformPath } from "../../xschem-viewer/src/waveforms/rawFileTcl";

export interface WaveformFiles {
  schematic: string;
  simulationDirectory: string;
  workspace?: string;
  picked?: string;
}

export function contained(path: string, root: string): boolean {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`);
}

export type WaveformTask =
  | { type: "parse"; path: string; graphs: WaveGraphRequest[] }
  | {
      type: "resolve";
      expressions: string[];
      files: WaveformFiles;
      roots: string[];
    };

async function findFile(
  graph: WaveGraphRequest,
  files: WaveformFiles,
  roots: string[],
  evaluated?: TclWaveformPath,
): Promise<string | undefined> {
  if (files.picked) return files.picked;

  const directory = dirname(files.schematic);
  if (evaluated && "error" in evaluated)
    throw new Error(
      `Cannot evaluate Tcl rawfile ${graph.rawFile}\n${evaluated.error}`,
    );
  if (evaluated && !evaluated.path.trim())
    throw new Error(`Tcl rawfile returned no waveform path: ${graph.rawFile}`);

  const configured =
    evaluated?.path ??
    graph.rawFile
      ?.trim()
      .replace(
        /^\$\{netlist_dir\}|^\$netlist_dir(?=[/\\]|$)/,
        () => files.simulationDirectory,
      );
  const dirs = evaluated ? [directory] : [directory, files.simulationDirectory];
  let candidates: string[][];
  if (configured) {
    candidates = [dirs.map((dir) => resolve(dir, configured))];
  } else {
    const stem = basename(files.schematic, extname(files.schematic));
    const names = [`${stem}.${graph.analysis || "tran"}.raw`];
    if (graph.analysis === "ac") names.push(`${stem}.sp.raw`);
    if (graph.analysis === "dc") names.push(`${stem}.sweep.raw`);
    names.push(`${stem}.raw`);
    candidates = names.map((name) => dirs.map((dir) => join(dir, name)));
  }
  for (const group of candidates) {
    const found = await Promise.all(
      [...new Set(group)].map(async (candidate) => {
        try {
          if (extname(candidate).toLowerCase() !== ".raw") return undefined;
          const path = await realpath(candidate);
          if (!roots.some((root) => contained(path, root))) return undefined;
          const info = await stat(path);
          return info.isFile() ? { path, time: info.mtimeMs } : undefined;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          return undefined;
        }
      }),
    );
    const newest = found
      .filter((file) => file !== undefined)
      .sort((a, b) => b.time - a.time)[0];
    if (newest) return newest.path;
  }
  if (configured) {
    throw new Error(
      `Cannot find waveform file ${configured}${
        evaluated ? ` returned by Tcl rawfile ${graph.rawFile}` : ""
      }`,
    );
  }
}

async function runWorker<T>(
  workerPath: string,
  task: WaveformTask,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const worker = new Worker(workerPath, { workerData: task });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (task.type === "resolve") {
        timer = setTimeout(
          () => reject(new Error("Tcl rawfile evaluation timed out")),
          10000,
        );
      }
      worker.once("message", (result: { value: T } | { error: string }) => {
        if ("error" in result) reject(new Error(result.error));
        else resolve(result.value);
      });
      worker.once("error", reject);
      worker.once("exit", () =>
        reject(new Error("The waveform worker stopped before returning data")),
      );
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    void worker.terminate();
  }
}

export async function loadWaveformGraphs(
  graphs: WaveGraphRequest[],
  files: WaveformFiles,
  workerPath: string,
  signal?: AbortSignal,
): Promise<WaveGraphResult[]> {
  const roots = (
    await Promise.all(
      [dirname(files.schematic), files.simulationDirectory, files.workspace]
        .filter((root) => root !== undefined)
        .map((root) => realpath(root).catch(() => undefined)),
    )
  ).filter((root) => root !== undefined);

  const evaluated = new Map<string, TclWaveformPath>();
  if (!files.picked) {
    const expressions = [
      ...new Set(
        graphs
          .filter((graph) => graph.traces.length > 0)
          .map((graph) => rawFileExpression(graph.rawFile))
          .filter((expression) => expression !== undefined),
      ),
    ];
    if (expressions.length) {
      try {
        const paths = await runWorker<TclWaveformPath[]>(
          workerPath,
          { type: "resolve", expressions, files, roots },
          signal,
        );
        expressions.forEach((expression, index) =>
          evaluated.set(expression, paths[index]),
        );
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        expressions.forEach((expression) =>
          evaluated.set(expression, { error: message }),
        );
      }
    }
  }

  const results: WaveGraphResult[] = graphs.map(() => ({
    series: [],
    warnings: [],
  }));
  const groups = new Map<string, number[]>();
  await Promise.all(
    graphs.map(async (graph, index) => {
      if (graph.traces.length === 0) return;
      try {
        const expression = rawFileExpression(graph.rawFile);
        const path = await findFile(
          graph,
          files,
          roots,
          expression === undefined ? undefined : evaluated.get(expression),
        );
        if (path === undefined) return;
        const indices = groups.get(path) ?? [];
        indices.push(index);
        groups.set(path, indices);
      } catch (error) {
        results[index].error =
          error instanceof Error ? error.message : String(error);
      }
    }),
  );
  for (const [path, indices] of groups) {
    signal?.throwIfAborted();
    try {
      const data = await runWorker<WaveGraphResult[]>(
        workerPath,
        { type: "parse", path, graphs: indices.map((index) => graphs[index]) },
        signal,
      );
      for (const [i, index] of indices.entries()) results[index] = data[i];
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      for (const index of indices)
        results[index].error = `${basename(path)}: ${message}`;
    }
    const source = { basename: basename(path), manual: path === files.picked };
    for (const index of indices) {
      const result = results[index];
      result.source = source;
      result.warnings = result.warnings.map(
        (warning) => `${source.basename}: ${warning}`,
      );
    }
  }
  return results;
}
