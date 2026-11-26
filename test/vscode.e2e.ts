import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Frame,
} from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("renders a schematic and opens its library child in VS Code", async ({}, testInfo) => {
  const executablePath = process.env.XSCHEM_TEST_VSCODE;
  test.skip(
    !executablePath,
    "Set XSCHEM_TEST_VSCODE to the VS Code executable to run this smoke test.",
  );

  const temporary = await mkdtemp(join(tmpdir(), "xschem-vscode-"));
  let app: ElectronApplication | undefined;
  try {
    const workspace = join(temporary, "workspace");
    const library = join(workspace, "library");
    const schematic = join(workspace, "top.sch");
    const profile = join(temporary, "profile");
    const userSettings = join(profile, "User");
    await mkdir(library, { recursive: true });
    await mkdir(userSettings, { recursive: true });
    await writeFile(
      join(userSettings, "settings.json"),
      JSON.stringify({
        "workbench.startupEditor": "none",
        "workbench.editorAssociations": { "*.sch": "xschem.viewXschem" },
      }),
    );
    await writeFile(
      join(workspace, "xschem.toml"),
      '[settings]\ngraphLineWidthMult = 2.5\n\n[libraries]\nlocal = { path = "library" }\n',
    );
    await writeFile(schematic, "C {block.sym} 0 0 0 0 {name=X1}");
    await writeFile(
      join(library, "block.sym"),
      "K {type=subcircuit}\nL 4 0 0 50 0 {}\nT {@name} 0 10 0 0 0.2 0.2 {}",
    );
    await writeFile(
      join(library, "block.sch"),
      "T {Child schematic} 0 0 0 0 0.2 0.2 {}",
    );

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    );
    app = await _electron.launch({
      executablePath,
      env,
      args: [
        `--user-data-dir=${profile}`,
        `--extensions-dir=${join(temporary, "extensions")}`,
        `--extensionDevelopmentPath=${resolve(".")}`,
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        workspace,
        "--goto",
        schematic,
      ],
      timeout: 30000,
    });
    const window = await app.firstWindow();
    let preview: Frame | undefined;
    await expect
      .poll(
        async () => {
          for (const frame of window.frames()) {
            if (await frame.locator("body[data-document]").count()) {
              preview = frame;
              return true;
            }
          }
          return false;
        },
        { timeout: 30000 },
      )
      .toBe(true);

    const frame = preview!;
    await expect(frame.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(frame.locator("body")).toHaveAttribute(
      "data-graph-line-width-mult",
      "2.5",
    );
    await expect(frame.locator("#diagnostics")).toBeHidden();
    const stack = frame.locator("#file-stack li");
    await expect(stack).toHaveText(["top.sch"]);
    const block = frame.locator('g[data-symbol="block.sym"]');
    await expect(block.locator("line")).toHaveCount(1);
    await block.getByText("X1", { exact: true }).dblclick();
    await expect(stack).toHaveText(["top.sch", join("library", "block.sch")]);
    await expect(frame.locator("svg")).toContainText("Child schematic");
    await expect(frame.locator("#diagnostics")).toBeHidden();
  } catch (error) {
    await app
      ?.windows()[0]
      ?.screenshot({ path: testInfo.outputPath("vscode.png") })
      .catch(() => {});
    throw error;
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
