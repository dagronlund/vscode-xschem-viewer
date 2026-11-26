import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  projectSettingsFilename,
  type ProjectSettings,
} from "../../xschem-viewer/src/model/projectSettings";
import { instantiateParser } from "../../xschem-viewer/src/parser/wasm";
import { FileResolver } from "./resolver";

export { projectSettingsFilename };

let manifestParser: ReturnType<typeof instantiateParser> | undefined;

function loadManifestParser() {
  manifestParser ??= readFile(
    join(__dirname, "assets/xschem_viewer_parser.wasm"),
  )
    .then((bytes) => WebAssembly.compile(new Uint8Array(bytes)))
    .then((module) => instantiateParser(module));
  return manifestParser;
}

export async function readProjectSettings(
  folder: vscode.Uri,
): Promise<ProjectSettings | undefined> {
  const uri = vscode.Uri.joinPath(folder, projectSettingsFilename);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const { parseManifest } = await loadManifestParser();
    return parseManifest(new TextDecoder().decode(bytes));
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    )
      return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${uri.fsPath}: ${message}`);
  }
}

export function expandPath(
  value: string,
  document: vscode.Uri,
  projectFolder?: vscode.Uri,
): string {
  const folder = vscode.workspace.getWorkspaceFolder(document);
  let expanded = value.replace(
    /\$\{workspaceFolder(?::([^}]+))?\}/g,
    (_match, name: string | undefined) => {
      if (name === undefined && projectFolder) return projectFolder.fsPath;
      const selected = name
        ? vscode.workspace.workspaceFolders?.find((item) => item.name === name)
        : folder;
      if (!selected)
        throw new Error(`No workspace folder for ${name ?? document.fsPath}`);
      return selected.uri.fsPath;
    },
  );
  expanded = expanded.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => {
    if (process.env[name] === undefined)
      throw new Error(`Environment variable ${name} is not set`);
    return process.env[name]!;
  });
  return expanded.replace(/^~(?=$|[/\\])/, homedir());
}

export function configuredPath(
  value: string,
  document: vscode.Uri,
  projectFolder?: vscode.Uri,
): string {
  const expanded = expandPath(value, document, projectFolder);
  const base =
    projectFolder ??
    vscode.workspace.getWorkspaceFolder(document)?.uri ??
    vscode.Uri.joinPath(document, "..");
  return isAbsolute(expanded) ? expanded : resolve(base.fsPath, expanded);
}

export function createResolver(
  document: vscode.Uri,
  projectFolder: vscode.Uri,
  projectSettings?: ProjectSettings,
): FileResolver {
  const configuration = vscode.workspace.getConfiguration("xschem", document);
  const workspace = vscode.workspace.getWorkspaceFolder(document);
  const projectLibraries = vscode.workspace.isTrusted
    ? projectSettings?.libraryPaths
    : undefined;
  const configured =
    projectLibraries?.flatMap(({ path }) =>
      path === undefined ? [] : [path],
    ) ?? configuration.get<string[]>("libraryPaths", []);
  const environment = (process.env.XSCHEM_LIBRARY_PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const roots = [
    vscode.Uri.joinPath(document, ".."),
    ...configured.map((path) =>
      vscode.Uri.file(
        configuredPath(
          path,
          document,
          projectLibraries === undefined ? undefined : projectFolder,
        ),
      ),
    ),
    ...(workspace ? [workspace.uri] : []),
    ...environment.map((path) =>
      vscode.Uri.file(configuredPath(path, document)),
    ),
  ];
  return new FileResolver(
    roots.map((uri) => uri.toString()),
    async (uri) =>
      new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.parse(uri)),
      ),
  );
}
