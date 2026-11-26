import type {
  WaveGraphRequest,
  WaveGraphResult,
  WaveTraceRequest,
} from "../../xschem-viewer/src/waveforms/types";

export type {
  WaveGraphRequest,
  WaveGraphResult,
} from "../../xschem-viewer/src/waveforms/types";

export interface ResolvedFile {
  uri: string;
  content: string;
}

export interface LoadedFile extends ResolvedFile {
  displayPath: string;
}

export interface LoadRequest {
  type: "load";
  id: number;
  reference: string;
  from: string;
}

export type LoadResponse =
  | { type: "loaded"; id: number; file: LoadedFile }
  | { type: "loaded"; id: number; error: string };

export function isLoadRequest(value: unknown): value is LoadRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<LoadRequest>;
  return (
    message.type === "load" &&
    Number.isSafeInteger(message.id) &&
    typeof message.reference === "string" &&
    typeof message.from === "string"
  );
}

export type WaveformAction = "load" | "pick" | "useAutomatic";

export interface WaveRequest {
  type: "waveforms";
  id: number;
  schematic: string;
  action: WaveformAction;
  graphs: WaveGraphRequest[];
}

export type WaveResponse =
  | { type: "waveformsLoaded"; id: number; graphs: WaveGraphResult[] }
  | { type: "waveformsLoaded"; id: number; error: string }
  | { type: "waveformsLoaded"; id: number; cancelled: true };

export type HostRequest = LoadRequest | WaveRequest;
export type HostResponse = LoadResponse | WaveResponse;

export function isWaveRequest(value: unknown): value is WaveRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<WaveRequest>;
  const shortText = (value: unknown): value is string =>
    typeof value === "string" && value.length <= 4096;
  const optionalNumber = (value: unknown) =>
    value === undefined || Number.isFinite(value);
  return (
    request.type === "waveforms" &&
    Number.isSafeInteger(request.id) &&
    shortText(request.schematic) &&
    (request.action === "load" ||
      request.action === "pick" ||
      request.action === "useAutomatic") &&
    Array.isArray(request.graphs) &&
    request.graphs.length <= 64 &&
    request.graphs.every(
      (graph) =>
        graph &&
        shortText(graph.analysis) &&
        (graph.rawFile === undefined || shortText(graph.rawFile)) &&
        typeof graph.logX === "boolean" &&
        optionalNumber(graph.xMin) &&
        optionalNumber(graph.xMax) &&
        Array.isArray(graph.traces) &&
        graph.traces.length <= 64 &&
        graph.traces.every(
          (trace: WaveTraceRequest) =>
            trace &&
            shortText(trace.name) &&
            (trace.sweep === undefined || shortText(trace.sweep)) &&
            Number.isInteger(trace.dataset) &&
            trace.dataset >= -1 &&
            trace.dataset < 2 ** 31,
        ),
    )
  );
}
