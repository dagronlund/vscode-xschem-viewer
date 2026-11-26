// SPDX-License-Identifier: Apache-2.0
// Original extension: Barak Hoffer. Local-library fork, 2026.
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  configuredPath,
  createResolver,
  expandPath,
  projectSettingsFilename,
  readProjectSettings,
} from "./configuration";
import { webviewHtml } from "./html";
import { registerXschemLanguage } from "./language";
import { isLoadRequest, isWaveRequest, type WaveResponse } from "./protocol";
import { respondToLoad } from "./resolver";
import { loadWaveformGraphs } from "./waveform-files";

export function activate(context: vscode.ExtensionContext): void {
  registerXschemLanguage(context);
  const output = vscode.window.createOutputChannel("Xschem Viewer");
  const provider = new XschemEditorProvider(context, output);
  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider("xschem.viewXschem", provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("xschem.editSchematic", () =>
      provider.launch(false),
    ),
    vscode.commands.registerCommand("xschem.runSimulation", () =>
      provider.launch(true),
    ),
  );
}

export class XschemEditorProvider
  implements vscode.CustomReadonlyEditorProvider
{
  private activeDocument?: vscode.CustomDocument;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async launch(simulate: boolean): Promise<void> {
    const uri = this.activeDocument?.uri;
    if (!uri) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage(
        "Trust this workspace before launching native Xschem.",
      );
      return;
    }
    if (uri.scheme !== "file") {
      void vscode.window.showErrorMessage(
        "Native Xschem launch requires a local file.",
      );
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration("xschem", uri);
      const value = expandPath(config.get<string>("executable", "xschem"), uri);
      const executable = /[/\\]/.test(value)
        ? configuredPath(value, uri)
        : value;
      const args = config
        .get<string[]>("arguments", [])
        .map((argument) => expandPath(argument, uri));
      if (simulate) args.push("-x", "-n", "-S", "-q");
      args.push(uri.fsPath);
      const cwd =
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ??
        vscode.Uri.joinPath(uri, "..").fsPath;
      this.output.appendLine(
        `Launching ${JSON.stringify([executable, ...args])} in ${cwd}`,
      );
      const child = spawn(executable, args, { cwd, shell: false });
      child.stdout.on("data", (data: Buffer) =>
        this.output.append(data.toString()),
      );
      child.stderr.on("data", (data: Buffer) =>
        this.output.append(data.toString()),
      );
      child.on("error", (error) => {
        this.output.appendLine(error.message);
        void vscode.window.showErrorMessage(
          `Cannot launch Xschem: ${error.message}`,
        );
      });
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          this.output.show(true);
          void vscode.window.showErrorMessage(
            `Xschem exited with code ${code}. See Xschem Viewer output.`,
          );
        }
      });
    } catch (error) {
      void vscode.window.showErrorMessage(String(error));
    }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    this.activeDocument = document;
    let resolver: ReturnType<typeof createResolver> | undefined;
    let activeWaveRequest: AbortController | undefined;
    const loadedSchematics = new Set<string>();
    const pickedResults = new Map<string, string>();
    const waveWorker = vscode.Uri.joinPath(dist, "waveform-worker.cjs").fsPath;
    const projectFolder =
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri ??
      vscode.Uri.joinPath(document.uri, "..");
    const settingsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectFolder, projectSettingsFilename),
    );
    const subscriptions: vscode.Disposable[] = [settingsWatcher];
    let refreshId = 0;
    const refresh = async (): Promise<void> => {
      const id = ++refreshId;
      try {
        const settings = await readProjectSettings(projectFolder);
        if (id !== refreshId) return;
        const nextResolver = createResolver(
          document.uri,
          projectFolder,
          settings,
        );
        const graphLineWidthMult =
          settings?.graphLineWidthMult ??
          vscode.workspace
            .getConfiguration("xschem", document.uri)
            .get<number>("graphLineWidthMult");
        activeWaveRequest?.abort();
        loadedSchematics.clear();
        resolver = nextResolver;
        panel.webview.html = webviewHtml(
          document.uri.toString(),
          panel.webview.asWebviewUri(dist).toString(),
          panel.webview.cspSource,
          randomBytes(16).toString("hex"),
          graphLineWidthMult,
        );
      } catch (error) {
        if (id !== refreshId) return;
        this.output.appendLine(String(error));
        void vscode.window.showErrorMessage(
          `Cannot configure Xschem Viewer: ${String(error)}`,
        );
      }
    };
    subscriptions.push(
      settingsWatcher.onDidCreate(refresh),
      settingsWatcher.onDidChange(refresh),
      settingsWatcher.onDidDelete(refresh),
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) this.activeDocument = document;
      }),
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (isLoadRequest(message) && resolver) {
          const currentResolver = resolver;
          const response = await respondToLoad(
            currentResolver,
            message,
            (uri) => vscode.workspace.asRelativePath(vscode.Uri.parse(uri)),
          );
          if (resolver !== currentResolver) return;
          if ("error" in response) this.output.appendLine(response.error);
          else if (
            new URL(response.file.uri).pathname.toLowerCase().endsWith(".sch")
          )
            loadedSchematics.add(response.file.uri);
          await panel.webview.postMessage(response);
          return;
        }
        if (!isWaveRequest(message)) {
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "waveforms" &&
            "id" in message &&
            typeof message.id === "number"
          ) {
            await panel.webview.postMessage({
              type: "waveformsLoaded",
              id: message.id,
              error:
                "Waveform request exceeds the supported limits or has invalid settings",
            } satisfies WaveResponse);
          }
          return;
        }
        activeWaveRequest?.abort();
        const request = new AbortController();
        activeWaveRequest = request;
        const reply = async (response: WaveResponse): Promise<void> => {
          await panel.webview.postMessage(
            request.signal.aborted
              ? { type: "waveformsLoaded", id: message.id, cancelled: true }
              : response,
          );
        };
        try {
          if (!loadedSchematics.has(message.schematic))
            throw new Error("Waveforms require an open schematic");
          const uri = vscode.Uri.parse(message.schematic);
          if (uri.scheme !== "file")
            throw new Error("Waveform loading requires a local schematic");
          const workspace =
            vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
          const configured = vscode.workspace
            .getConfiguration("xschem", uri)
            .get<string>("simulationDirectory", "");
          const simulationDirectory = configured
            ? configuredPath(configured, uri)
            : join(workspace ?? dirname(uri.fsPath), "simulations");
          if (message.action === "pick") {
            const files = await vscode.window.showOpenDialog({
              title: "Load simulation waveforms",
              defaultUri: vscode.Uri.file(dirname(uri.fsPath)),
              canSelectMany: false,
              filters: { "SPICE raw files": ["raw"] },
            });
            if (!files?.length || request.signal.aborted) {
              await reply({
                type: "waveformsLoaded",
                id: message.id,
                cancelled: true,
              });
              return;
            }
            if (files[0].scheme !== "file")
              throw new Error("Select a local waveform file");
            pickedResults.set(message.schematic, files[0].fsPath);
          } else if (message.action === "useAutomatic") {
            pickedResults.delete(message.schematic);
          }
          const graphs = await loadWaveformGraphs(
            message.graphs,
            {
              schematic: uri.fsPath,
              simulationDirectory,
              workspace,
              picked: pickedResults.get(message.schematic),
            },
            waveWorker,
            request.signal,
          );
          for (const graph of graphs) {
            if (graph.error) this.output.appendLine(graph.error);
            for (const warning of graph.warnings)
              this.output.appendLine(warning);
          }
          await reply({ type: "waveformsLoaded", id: message.id, graphs });
        } catch (error) {
          const description =
            error instanceof Error ? error.message : String(error);
          if (!request.signal.aborted) this.output.appendLine(description);
          await reply({
            type: "waveformsLoaded",
            id: message.id,
            error: description,
          });
        } finally {
          if (activeWaveRequest === request) activeWaveRequest = undefined;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("xschem", document.uri)) void refresh();
      }),
    );
    panel.onDidDispose(() => {
      refreshId++;
      activeWaveRequest?.abort();
      for (const subscription of subscriptions) subscription.dispose();
      if (this.activeDocument === document) this.activeDocument = undefined;
    });
    await refresh();
  }
}
