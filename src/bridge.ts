import type {
  HostRequest,
  HostResponse,
  LoadedFile,
  WaveformAction,
  WaveGraphRequest,
  WaveResponse,
} from "./protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: HostRequest): void;
};

export class HostLibraryLoader {
  private readonly api = acquireVsCodeApi();
  private nextId = 0;
  private readonly pending = new Map<
    number,
    (response: HostResponse) => void
  >();
  private readonly cache = new Map<string, Promise<LoadedFile>>();

  constructor() {
    window.addEventListener("message", (event: MessageEvent<HostResponse>) => {
      const message = event.data;
      if (message?.type !== "loaded" && message?.type !== "waveformsLoaded")
        return;
      this.pending.get(message.id)?.(message);
    });
  }

  private request(
    message: HostRequest,
    description: string,
    timeoutMs?: number,
  ): Promise<HostResponse> {
    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : window.setTimeout(() => {
              this.pending.delete(message.id);
              reject(new Error(`Timed out loading ${description}`));
            }, timeoutMs);
      this.pending.set(message.id, (response) => {
        clearTimeout(timeout);
        this.pending.delete(message.id);
        resolve(response);
      });
      this.api.postMessage(message);
    });
  }

  clear(): void {
    this.cache.clear();
  }

  load(reference: string, from: string): Promise<LoadedFile> {
    const key = JSON.stringify([reference, from]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = this.request(
      { type: "load", id: this.nextId++, reference, from },
      reference,
      15000,
    ).then((response) => {
      if (response.type !== "loaded")
        throw new Error("Unexpected schematic response");
      if ("error" in response) throw new Error(response.error);
      return response.file;
    });
    this.cache.set(key, result);
    return result;
  }

  async waveforms(
    schematic: string,
    graphs: WaveGraphRequest[],
    action: WaveformAction,
  ): Promise<WaveResponse> {
    const response = await this.request(
      { type: "waveforms", id: this.nextId++, schematic, graphs, action },
      "waveforms",
    );
    if (response.type !== "waveformsLoaded")
      throw new Error("Unexpected waveform response");
    return response;
  }
}
