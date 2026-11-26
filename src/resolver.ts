import type { LoadRequest, LoadResponse, ResolvedFile } from "./protocol";

/** Search local URIs without sending filesystem requests through the webview. */
export class FileResolver {
  private readonly roots: string[];

  constructor(
    roots: string[],
    private readonly readFile: (uri: string) => Promise<string>,
  ) {
    this.roots = [...new Set(roots.map((root) => root.replace(/\/?$/, "/")))];
  }

  private allowed(uri: string): boolean {
    const candidate = new URL(uri);
    return this.roots.some((root) => {
      const base = new URL(root);
      return (
        candidate.protocol === base.protocol &&
        candidate.host === base.host &&
        candidate.pathname.startsWith(base.pathname)
      );
    });
  }

  async load(reference: string, from: string): Promise<ResolvedFile> {
    if (!this.allowed(from))
      throw new Error(`Containing file is outside the library roots: ${from}`);
    const bases = [new URL(".", from).href, ...this.roots];
    let candidates: string[];
    if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
      candidates = [new URL(reference).href];
    } else {
      // Escape filenames so #, ? and % remain part of the path.
      const path = reference
        .replaceAll("\\", "/")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      candidates = [...new Set(bases.map((base) => new URL(path, base).href))];
    }
    const searched: string[] = [];
    for (const uri of candidates) {
      if (!this.allowed(uri)) {
        searched.push(`${uri} (outside the library roots)`);
        continue;
      }
      try {
        return { uri, content: await this.readFile(uri) };
      } catch (error) {
        searched.push(
          `${uri} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    throw new Error(
      `Cannot resolve ${reference}\nFrom: ${from}\nSearched:\n${searched.join("\n")}`,
    );
  }
}

export async function respondToLoad(
  resolver: FileResolver,
  request: LoadRequest,
  displayPath: (uri: string) => string,
): Promise<LoadResponse> {
  try {
    const file = await resolver.load(request.reference, request.from);
    return {
      type: "loaded",
      id: request.id,
      file: { ...file, displayPath: displayPath(file.uri) },
    };
  } catch (error) {
    return {
      type: "loaded",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
