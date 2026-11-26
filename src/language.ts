import * as vscode from "vscode";

const xschemHeader = /^[ \t]*v[ \t]+\{[ \t]*xschem[ \t]+version[ \t]*=/;

export function registerXschemLanguage(context: vscode.ExtensionContext): void {
  const checked = new WeakSet<vscode.TextDocument>();

  async function detectLanguage(document: vscode.TextDocument): Promise<void> {
    if (
      document.languageId !== "plaintext" ||
      !/\.(sch|sym)$/i.test(document.uri.path) ||
      checked.has(document)
    ) {
      return;
    }
    checked.add(document);

    for (let index = 0; index < document.lineCount; index++) {
      const line = document.lineAt(index);
      if (line.isEmptyOrWhitespace) continue;
      if (xschemHeader.test(line.text) && !hasFileAssociation(document)) {
        await vscode.languages.setTextDocumentLanguage(document, "xschem");
      }
      return;
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(detectLanguage),
  );
  for (const document of vscode.workspace.textDocuments) {
    void detectLanguage(document);
  }
}

function hasFileAssociation(document: vscode.TextDocument): boolean {
  const associations = vscode.workspace
    .getConfiguration("files", document.uri)
    .get<Record<string, string>>("associations", {});
  return Object.keys(associations).some((pattern) =>
    vscode.languages.match(
      { pattern: pattern.includes("/") ? pattern : `**/${pattern}` },
      document,
    ),
  );
}
