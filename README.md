# Xschem Viewer with local libraries

Preview Xschem schematics and symbols in VS Code with local libraries and hierarchy navigation.
This is a fork of two existing projects (this extension and the standalone web viewer).

- VS Code extension ([dagronlund/vscode-xschem-viewer](https://github.com/dagronlund/vscode-xschem-viewer))
    - Fork of ([barakhoffer/vscode-xschem-viewer](https://github.com/barakhoffer/vscode-xschem-viewer))
- Standalone web viewer ([dagronlund/xschem-viewer](https://github.com/dagronlund/xschem-viewer))
    - Fork of ([TinyTapeout/xschem-viewer](https://github.com/TinyTapeout/xschem-viewer))
- Rust parser ([dagronlund/xschem-rs](https://github.com/dagronlund/xschem-rs))

## Build and install

Requires Node.js 22 or newer, npm, Git, Rust with its WebAssembly target, and sibling checkouts of the web viewer and Rust parser at `../xschem-viewer` and `../xschem-rs`.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run package
code --install-extension ./vscode-xschem-viewer-1.1.3.vsix --force
```

Reload VS Code after installing.
The extension opens `.sch` or `.sym` files in the graphical preview by default.
To edit the source, right-click the tab and choose **Reopen Editor With → Text Editor**.
Syntax highlighting in the text editor uses the `v {xschem version=…}` header on the first nonblank line to identify Xschem files.

## Library configuration

Create `xschem.toml` at the root of the VS Code workspace folder that contains the drawing.

```toml
[libraries]
devices = { path = "libraries/devices" }
symbols = { path = "libraries/symbols" }
```

In a trusted workspace, the preview searches the containing file's directory, the `[libraries]` entries in order, the workspace root, and then `XSCHEM_LIBRARY_PATH`.
The `xschem.libraryPaths` VS Code setting supplies the library entries when `[libraries]` is absent or the workspace is untrusted.

## Preview and hierarchy

Double-click a component, or focus it and press Enter, to open its schematic view.
Use **Up** to open the parent schematic, **Top** to return to the original file, and **Reload** to reread the current file.
Scroll to zoom and drag to pan.
For missing symbols, check the attempted paths in the error panel or the **Xschem Viewer** Output channel.

## Waveforms

Schematic graphs display saved ngspice results.
The viewer uses the graph's `rawfile` when set, or looks beside the schematic and in the workspace's `simulations` directory for files such as `<schematic>.<analysis>.raw` and `<schematic>.raw`.
Set `xschem.simulationDirectory` to use a different results directory.
Use **Load Waves…** to pick a file or **Reload** to reread saved results.

Click a graph to open the **Waveform** sidebar.
Hold Alt/Option while dragging to pan or scrolling to zoom.
Use **Link X** to synchronize compatible plots and **Reset to Saved View** to restore their saved ranges.

## Native commands

**Open in Xschem** and **Run Xschem Simulation** use the configured executable and argument array.
They run from the workspace root and pass paths as separate arguments without a shell.
Simulation adds `-x -n -S -q` before the opened file's path.
Native commands require a trusted workspace and report launch failures in VS Code.

## Verification

```sh
npm test           # Resolver unit tests
npm run build
npm run test:e2e   # Browser tests
```

On macOS the browser tests use installed Google Chrome by default.
On other platforms run `npx playwright install chromium` before running them.
Set `CHROME_BIN` to use a different browser executable.

To run the optional smoke test in an installed copy of VS Code, point `XSCHEM_TEST_VSCODE` at the application executable.

```sh
XSCHEM_TEST_VSCODE=/path/to/vscode-executable \
npm run test:e2e -- vscode.e2e.ts
```
