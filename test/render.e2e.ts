import { test, expect, type Page } from "@playwright/test";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { FileResolver, respondToLoad } from "../src/resolver";
import { webviewHtml } from "../src/html";
import type { HostRequest, LoadRequest, WaveRequest } from "../src/protocol";
import { loadWaveformGraphs } from "../src/waveform-files";

const root = resolve(".");
const uri = (path: string): string => pathToFileURL(path).href;

async function openViewer(
  page: Page,
  document: string,
  roots: string[],
  graphLineWidthMult?: number,
  pickedWaveform?: string,
): Promise<{
  requests: LoadRequest[];
  waveRequests: WaveRequest[];
  errors: string[];
}> {
  const resolver = new FileResolver(roots.map(uri), async (path) =>
    readFile(fileURLToPath(path), "utf8"),
  );
  const requests: LoadRequest[] = [];
  const waveRequests: WaveRequest[] = [];
  const pickedResults = new Map<string, string>();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.exposeFunction("__hostRequest", async (request: HostRequest) => {
    if (request.type === "waveforms") {
      waveRequests.push(request);
      if (request.action === "pick" && pickedWaveform)
        pickedResults.set(request.schematic, pickedWaveform);
      if (request.action === "useAutomatic")
        pickedResults.delete(request.schematic);
      return {
        type: "waveformsLoaded",
        id: request.id,
        graphs: await loadWaveformGraphs(
          request.graphs,
          {
            schematic: fileURLToPath(request.schematic),
            workspace: roots[0],
            simulationDirectory: join(roots[0], "simulations"),
            picked: pickedResults.get(request.schematic),
          },
          join(root, "dist", "waveform-worker.cjs"),
        ),
      };
    }
    requests.push(request);
    return respondToLoad(resolver, request, (uri) => {
      const path = fileURLToPath(uri);
      const label = relative(roots[0], path);
      return !isAbsolute(label) &&
        label !== ".." &&
        !label.startsWith(`..${sep}`)
        ? label
        : path;
    });
  });
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      acquireVsCodeApi(): { postMessage(message: unknown): void };
      __hostRequest(message: unknown): Promise<unknown>;
    };
    bridge.acquireVsCodeApi = () => ({
      postMessage(message) {
        void bridge
          .__hostRequest(message)
          .then((data) =>
            window.dispatchEvent(new MessageEvent("message", { data })),
          );
      },
    });
  });
  await page.route("http://viewer.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: webviewHtml(
          uri(document),
          "http://viewer.test/",
          "http://viewer.test",
          "testnonce",
          graphLineWidthMult,
        ),
      });
    }
    try {
      const contentType = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream";
      return route.fulfill({
        contentType,
        body: await readFile(join(root, "dist", path)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "not found" });
    }
  });
  await page.goto("http://viewer.test/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  return { requests, waveRequests, errors };
}

test("loads saved waveform graphs, selects an analysis and dataset, and reloads raw files", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-waveforms-"));
  try {
    const schematic = join(temporary, "waves.sch");
    const raw = join(temporary, "waves.raw");
    await writeFile(
      schematic,
      [
        "T {Simulation fixture} 0 0 0 0 0.4 0.4 {}",
        'B 2 0 40 800 340 {flags=graph x1=0 x2=2n y1=0 y2=2 unitx=n node="Output; out" color=6 sim_type=tran dataset=1}',
        "B 2 0 360 800 660 {flags=graph x1=1 x2=2 logx=1 y1=0 y2=10 node=out color=4 sim_type=ac linewidth_mult=2}",
        "B 2 0 680 800 980 {flags=graph x1=0 x2=2 y1=0 y2=4 node=out color=7 sim_type=dc dataset=1}",
        String.raw`B 2 0 1000 800 1300 {flags=graph x1=1 x2=2 logx=1 y1=0 y2=20 node="\\"Gain (dB); out db20() %0\\"" sim_type=ac}`,
      ].join("\n"),
    );
    const plot = (
      title: string,
      axis: string,
      flags: string,
      rows: number[][],
    ) => {
      const header = Buffer.from(
        [
          "Title: Test",
          `Plotname: ${title}`,
          `Flags: ${flags}`,
          "No. Variables: 2",
          `No. Points: ${rows.length}`,
          "Variables:",
          `0 ${axis} ${axis}`,
          "1 v(out) voltage",
          "Binary:",
          "",
        ].join("\n"),
      );
      const values = Buffer.alloc(rows.flat().length * 8);
      rows
        .flat()
        .forEach((value, index) => values.writeDoubleLE(value, index * 8));
      return Buffer.concat([header, values]);
    };
    const ac = plot("AC Analysis", "frequency", "complex", [
      [10, 0, 3, 4],
      [100, 0, 0, 2],
    ]);
    const first = plot("Transient Analysis", "time", "real", [
      [0, 0],
      [1e-9, 0],
      [2e-9, 0],
    ]);
    const second = (middle: number) =>
      plot("Transient Analysis", "time", "real", [
        [0, 0],
        [1e-9, middle],
        [2e-9, 0],
      ]);
    const dc = plot("DC transfer characteristic", "v-sweep", "real", [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
      [1, 2],
      [2, 4],
    ]);
    await writeFile(raw, Buffer.concat([first, ac, dc, second(1)]));

    const { errors } = await openViewer(page, schematic, [temporary], 5);
    const tran = page.locator('[data-waveform-trace="Output"]');
    const acTrace = page.locator(
      '[data-waveform-graph="1"] [data-waveform-trace]',
    );
    const dcTrace = page.locator(
      '[data-waveform-graph="2"] [data-waveform-trace]',
    );
    await expect(tran).toHaveCount(1);
    await expect(tran).toHaveAttribute("stroke", "#00ccee");
    await expect(tran).toHaveAttribute("stroke-width", "3");
    await expect(acTrace).toHaveAttribute("stroke-width", "1.2");
    await expect(tran).toHaveAttribute(
      "d",
      "M112.000 258.000 L436.400 150.000 L760.800 258.000",
    );
    await expect(acTrace).toHaveAttribute(
      "d",
      "M112.000 150.000 L760.800 214.800",
    );
    await expect(
      page.locator('[data-waveform-trace="Gain (dB)"]'),
    ).toHaveAttribute("d", "M112.000 107.022 L760.800 192.978");
    await expect(dcTrace).toHaveAttribute(
      "d",
      "M112.000 258.000 L436.400 150.000 L760.800 42.000",
    );
    await expect(page.locator('[data-waveform-graph="0"]')).toContainText(
      "time[n]",
    );
    await expect(page.locator('[data-waveform-graph="1"]')).toContainText(
      "frequency",
    );
    const loadWaves = page.getByRole("button", { name: "Load Waves…" });
    await expect(loadWaves).toBeEnabled();
    const graph = page.locator('[data-waveform-graph="0"]');
    await graph.click();
    await expect(
      page.getByRole("heading", { name: "Waveform", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#selection-name")).toBeHidden();
    const details = page.locator("#selection-details");
    await expect(details.locator("dt")).toHaveText([
      "Layer",
      "Start (X, Y)",
      "End (X, Y)",
    ]);
    await expect(details.locator("dd")).toHaveText([
      "2",
      "(0, 40)",
      "(800, 340)",
    ]);
    await expect(
      page.locator(
        "#selection-details ~ #waveform-view ~ #selection-properties",
      ),
    ).toBeVisible();
    const properties = page.getByRole("table", { name: "Properties" });
    const node = properties.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "node", exact: true }),
    });
    await expect(node.getByRole("cell")).toHaveText("Output; out");

    await writeFile(raw, Buffer.concat([first, ac, dc, second(2)]));
    await loadWaves.click();
    await expect(tran).toHaveAttribute(
      "d",
      "M112.000 258.000 L436.400 42.000 L760.800 258.000",
    );
    await expect(graph).toHaveAttribute("data-selected", "");
    await rm(raw);
    await page.locator("#reload").click();
    await expect(page.locator("#selection-properties")).toBeHidden();
    await expect(tran).toHaveCount(0);
    await expect(page.locator('[data-waveform-graph="0"]')).toContainText(
      "No waveform data",
    );
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("plots postfix arithmetic from saved signal samples", async ({ page }) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-arithmetic-"));
  try {
    const schematic = join(temporary, "arithmetic.sch");
    const waves = [
      "Sum; a b +",
      "Difference; v(a) b - %0",
      "Scaled difference; a b - 500m *",
      "Ratio; a b /",
      "Missing operand; a missing +",
      "Incomplete expression; a +",
    ].map((wave) => String.raw`\\"${wave}\\"`);
    await writeFile(
      schematic,
      `B 2 0 0 800 300 {flags=graph x1=0 x2=2 y1=-2 y2=18 sim_type=tran node="${waves.join("\n")}"}`,
    );
    await writeFile(
      join(temporary, "arithmetic.tran.raw"),
      [
        "Title: Expression fixture",
        "Plotname: Transient Analysis",
        "Flags: real",
        "No. Variables: 3",
        "No. Points: 3",
        "Variables:",
        "0 time time",
        "1 v(a) voltage",
        "2 v(b) voltage",
        "Values:",
        "0 0",
        "  2",
        "  4",
        "1 1",
        "  3",
        "  0",
        "2 2",
        "  10",
        "  6",
        "",
      ].join("\n"),
    );

    const { errors } = await openViewer(page, schematic, [temporary]);
    await expect(page.locator("[data-waveform-trace]")).toHaveCount(4);
    for (const [label, path] of [
      ["Sum", "M112.000 171.600 L436.400 204.000 L760.800 63.600"],
      ["Difference", "M112.000 258.000 L436.400 204.000 L760.800 193.200"],
      [
        "Scaled difference",
        "M112.000 247.200 L436.400 220.200 L760.800 214.800",
      ],
      ["Ratio", "M112.000 231.000 M760.800 218.400"],
    ]) {
      await expect(
        page.locator(`[data-waveform-trace="${label}"]`),
      ).toHaveAttribute("d", path);
    }
    const warnings = page.locator("[data-waveform-graph] > title");
    await expect(warnings).toContainText("a missing +");
    await expect(warnings).toContainText("a +");
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pans, zooms, links, and resets plots independently of the schematic", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-views-"));
  try {
    const schematic = join(temporary, "views.sch");
    await writeFile(
      schematic,
      [
        "B 2 0 0 800 300 {flags=graph x1=0 x2=2 y1=0 y2=8 node=out sim_type=tran}",
        "B 2 850 0 1650 300 {flags=graph x1=1 x2=3 y1=0 y2=8 node=out sim_type=tran}",
        "B 2 0 350 800 650 {flags=graph,unlocked x1=1 x2=3 y1=0 y2=8 node=out sim_type=tran}",
        "B 2 850 350 1650 650 {flags=graph x1=0 x2=1 logx=1 y1=0 y2=8 node=out sim_type=tran}",
      ].join("\n"),
    );
    const values = [0, 1, 3, 6, 2, 5, 7, 4];
    await writeFile(
      join(temporary, "views.tran.raw"),
      [
        "Title: View fixture",
        "Plotname: Transient Analysis",
        "Flags: real",
        "No. Variables: 2",
        `No. Points: ${values.length}`,
        "Variables:",
        "0 time time",
        "1 v(out) voltage",
        "Values:",
        ...values.flatMap((y, x) => [`${x} ${x}`, `  ${y}`]),
        "",
      ].join("\n"),
    );
    const { waveRequests, errors } = await openViewer(page, schematic, [
      temporary,
    ]);
    const graph = (index: number) =>
      page.locator(`[data-waveform-graph="${index}"]`);
    const trace = (index: number) =>
      graph(index).locator("[data-waveform-trace]");
    const plot = (index: number) =>
      graph(index).locator(":scope > rect").nth(1);
    const schematicBounds = async () => {
      const { x, y, width, height } = (await page
        .locator("main > svg")
        .boundingBox())!;
      return [x, y, width, height];
    };
    const reset = page.getByRole("button", { name: "Reset to Saved View" });
    const link = page.getByRole("checkbox", { name: "Link X" });
    const load = page.getByRole("button", { name: "Load Waves…" });
    await expect(page.locator("[data-waveform-trace]")).toHaveCount(4);
    const saved = await Promise.all(
      [0, 1, 2, 3].map((index) => trace(index).getAttribute("d")),
    );
    const position = async (index: number, x = 0.5, y = 0.5) => {
      const box = (await plot(index).boundingBox())!;
      return {
        x: box.x + x * box.width,
        y: box.y + y * box.height,
        width: box.width,
      };
    };
    const lastRanges = () =>
      waveRequests.at(-1)?.graphs.map(({ xMin, xMax }) => [xMin, xMax]);
    const wheel = async (index: number, delta: number, x?: number) => {
      const point = await position(index, x);
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down("Alt");
      await page.mouse.wheel(0, delta);
      await page.keyboard.up("Alt");
    };

    // Unmodified scroll operates on the schematic, even over traces.
    const startTransform = await schematicBounds();
    const center = await position(0);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 70);
    await expect.poll(schematicBounds).not.toEqual(startTransform);
    await expect(trace(0)).toHaveAttribute("d", saved[0]!);
    expect(waveRequests).toHaveLength(1);

    const beforeArrow = await schematicBounds();
    await page.locator("main").focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(schematicBounds).not.toEqual(beforeArrow);
    expect(waveRequests).toHaveLength(1);

    await graph(0).click();
    await expect(link).toBeChecked();
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);
    const beforeGraphArrow = await schematicBounds();
    await graph(0).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(lastRanges).toEqual([
      [0.4, 2.4],
      [0.4, 2.4],
    ]);
    await expect(trace(1)).not.toHaveAttribute("d", saved[1]!);
    await expect.poll(schematicBounds).toEqual(beforeGraphArrow);
    await reset.click();
    await expect.poll(lastRanges).toEqual([
      [0, 2],
      [1, 3],
    ]);
    await expect(trace(0)).toHaveAttribute("d", saved[0]!);
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);
    await link.uncheck();

    await wheel(0, -120);
    await expect(link).not.toBeChecked();
    await expect(trace(0)).not.toHaveAttribute("d", saved[0]!);
    await expect.poll(() => lastRanges()?.length).toBe(1);
    expect(lastRanges()![0][0]).toBeGreaterThan(0);
    expect(lastRanges()![0][1]).toBeLessThan(2);
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);
    await reset.click();
    await expect.poll(lastRanges).toEqual([[0, 2]]);
    await expect(trace(0)).toHaveAttribute("d", saved[0]!);

    // Pan into a range beyond the saved samples and check the new raw request.
    const panStart = await position(0, 0.8);
    const beforePan = await schematicBounds();
    await page.mouse.move(panStart.x, panStart.y);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(panStart.x - 0.55 * panStart.width, panStart.y, {
      steps: 6,
    });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect.poll(() => lastRanges()?.[0]?.[1]).toBeGreaterThan(3);
    await expect(load).toBeEnabled();
    await expect.poll(schematicBounds).toEqual(beforePan);
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);

    await link.check();
    const yBefore = await trace(0).getAttribute("d");
    const requestCount = waveRequests.length;
    await wheel(0, -120, -0.09);
    await expect(trace(0)).not.toHaveAttribute("d", yBefore!);
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);
    expect(waveRequests).toHaveLength(requestCount);

    await graph(0).focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => lastRanges()?.length).toBe(2);
    expect(lastRanges()![1]).toEqual(lastRanges()![0]);
    await expect(trace(1)).not.toHaveAttribute("d", saved[1]!);
    await expect(trace(2)).toHaveAttribute("d", saved[2]!);
    await expect(trace(3)).toHaveAttribute("d", saved[3]!);
    await expect(load).toBeEnabled();

    const linkedTrace = await trace(0).getAttribute("d");
    await wheel(2, -120);
    await expect(link).toBeDisabled();
    await expect.poll(() => lastRanges()?.length).toBe(1);
    await expect(trace(2)).not.toHaveAttribute("d", saved[2]!);
    await expect(trace(0)).toHaveAttribute("d", linkedTrace!);
    await expect(load).toBeEnabled();

    await graph(0).click();
    await expect(link).toBeChecked();
    await reset.click();
    await expect.poll(lastRanges).toEqual([
      [0, 2],
      [1, 3],
    ]);
    await expect(trace(0)).toHaveAttribute("d", saved[0]!);
    await expect(trace(1)).toHaveAttribute("d", saved[1]!);
    await expect(trace(2)).not.toHaveAttribute("d", saved[2]!);
    await expect(trace(3)).toHaveAttribute("d", saved[3]!);
    // Do the ordinary drag last so its kinetic scroll cannot overlap a plot gesture.
    const beforeDragRequests = waveRequests.length;
    const zoomedTransform = await schematicBounds();
    const dragStart = await position(0);
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 30, dragStart.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(schematicBounds).not.toEqual(zoomedTransform);
    await expect(trace(0)).toHaveAttribute("d", saved[0]!);
    expect(waveRequests).toHaveLength(beforeDragRequests);
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("loads ASCII waveforms from the graph's configured raw file", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-ascii-"));
  try {
    const schematic = join(temporary, "wave.sch");
    const directory = join(temporary, "simulations");
    await mkdir(directory);
    await writeFile(
      schematic,
      "B 2 0 0 800 300 {flags=graph rawfile=$netlist_dir/result.raw node=out sim_type=tran x1=0 x2=1 y1=0 y2=2}",
    );
    await writeFile(
      join(directory, "result.raw"),
      [
        "Title: ASCII",
        "Plotname: Transient Analysis",
        "Flags: real",
        "No. Variables: 2",
        "No. Points: 2",
        "Variables:",
        "0 time time",
        "1 v(out) voltage",
        "Values:",
        "0 0",
        "  1",
        "",
        "1 1",
        "  2",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(temporary, "wave.tran.raw"),
      asciiTransient(["v(out)"]),
    );
    const { errors } = await openViewer(page, schematic, [temporary]);
    await expect(page.locator('[data-waveform-trace="out"]')).toHaveAttribute(
      "d",
      "M112.000 150.000 L760.800 42.000",
    );
    await page.locator('[data-waveform-graph="0"]').click();
    await expect(page.locator("#waveform-source")).toHaveText(
      "Waveform file result.raw",
    );
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const rawFileExpression = String.raw`"[if \{[xschem raw loaded] >= 0 && [xschem raw sim_type] eq \{tran\}\} \{xschem raw rawfile\} else \{file join [xschem get current_dirname] wave.tran.raw\}]"`;

test("loads SP Analysis waveforms from the newest raw file selected by sourced Tcl", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-sp-"));
  try {
    const directory = join(temporary, "channel");
    const simulations = join(temporary, "simulations");
    await mkdir(directory);
    await mkdir(simulations);
    const schematic = join(directory, "channel.sch");
    await writeFile(
      schematic,
      'B 2 0 0 800 300 {flags=graph rawfile="[source [file join [file dirname [xschem get schname]] .. load_waves.tcl]; latest_waveform sp]" node="Loss;loss\nPhase;re(phase)" sim_type=ac dataset=0 x1=5e8 x2=2.5e9 y1=-180 y2=20}',
    );
    await writeFile(
      join(temporary, "load_waves.tcl"),
      `proc latest_waveform {kind} {
        global netlist_dir
        set schematic [xschem get schname]
        set name [file rootname [file tail $schematic]]
        set latest {}
        foreach directory [list $netlist_dir [file dirname $schematic]] {
          foreach candidate [glob -nocomplain -types f -directory $directory -- \${name}.\${kind}.raw \${name}.*.\${kind}.raw] {
            if {$latest eq {} || [file mtime $candidate] > [file mtime $latest]} {
              set latest $candidate
            }
          }
        }
        return $latest
      }`,
    );
    const stale = join(directory, "channel.sp.raw");
    await writeFile(stale, asciiTransient(["v(out)"]));
    await utimes(stale, 1, 1);
    await writeFile(
      join(simulations, "channel.new.sp.raw"),
      [
        "Title: Channel",
        "Plotname: SP Analysis",
        "Flags: complex",
        "No. Variables: 3",
        "No. Points: 2",
        "Variables:",
        "0 frequency frequency",
        "1 loss decibel",
        "2 phase notype",
        "Values:",
        "0 5e8,0",
        "  5,0",
        "  -30,0",
        "1 2.5e9,0",
        "  10,0",
        "  -120,0",
        "",
      ].join("\n"),
    );

    const { errors } = await openViewer(page, schematic, [temporary]);
    await expect(page.locator('[data-waveform-trace="Loss"]')).toHaveAttribute(
      "d",
      "M112.000 58.200 L760.800 52.800",
    );
    await expect(page.locator('[data-waveform-trace="Phase"]')).toHaveAttribute(
      "d",
      "M112.000 96.000 L760.800 193.200",
    );
    await page.locator('[data-waveform-graph="0"]').click();
    await expect(page.locator("#waveform-source")).toHaveText(
      "Waveform file channel.new.sp.raw",
    );
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function asciiTransient(signals: string[]): string {
  return [
    "Title: Waveform resolution fixture",
    "Plotname: Transient Analysis",
    "Flags: real",
    `No. Variables: ${signals.length + 1}`,
    "No. Points: 2",
    "Variables:",
    "0 time time",
    ...signals.map((name, index) => `${index + 1} ${name} voltage`),
    "Values:",
    "0 0",
    ...signals.map(() => "  0"),
    "1 1",
    ...signals.map(() => "  1"),
    "",
  ].join("\n");
}

test("overlays paired traces from 72 datasets in a Tcl-selected eye file", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-eye-"));
  try {
    const schematic = join(temporary, "channel.sch");
    await writeFile(
      schematic,
      'B 2 0 0 800 300 {flags=graph rawfile="[file join [xschem get current_dirname] channel.eye.raw]" node="in\nout" sim_type=tran dataset=-1 x1=0 x2=1 y1=0 y2=2}',
    );
    const dataset = asciiTransient(["v(in)", "v(out)"]);
    await writeFile(join(temporary, "channel.tran.raw"), dataset);
    await writeFile(join(temporary, "channel.eye.raw"), dataset.repeat(72));
    const { errors } = await openViewer(page, schematic, [temporary]);
    await expect(page.locator("[data-waveform-trace]")).toHaveCount(144);
    await page.locator('[data-waveform-graph="0"]').click();
    await expect(page.locator("#waveform-source")).toHaveText(
      "Waveform file channel.eye.raw",
    );
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("restores the Tcl-selected waveform after a manual pick", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-expression-"));
  try {
    const schematic = join(temporary, "wave.sch");
    const picked = join(temporary, "other-testbench.raw");
    await writeFile(
      schematic,
      `B 2 0 0 800 300 {flags=graph rawfile=${rawFileExpression} node="CLK\nxstage.out\nv(DATA[0])" sim_type=tran x1=0 x2=1 y1=0 y2=2}`,
    );
    await writeFile(
      join(temporary, "wave.tran.raw"),
      asciiTransient(["v(clk)", "v(xstage.out)", "v(data[0])"]),
    );
    await writeFile(picked, asciiTransient(["v(clk)"]));
    const { errors } = await openViewer(
      page,
      schematic,
      [temporary],
      undefined,
      picked,
    );
    const graph = page.locator('[data-waveform-graph="0"]');
    const traces = graph.locator("[data-waveform-trace]");
    const source = page.locator("#waveform-source");
    const diagnostics = page.locator("#diagnostics");
    const automatic = page.getByRole("button", {
      name: "Use automatic waveform",
    });
    await expect(traces).toHaveCount(3);
    await graph.click();
    await expect(source).toHaveText("Waveform file wave.tran.raw");
    await expect(diagnostics).toBeHidden();
    await expect(automatic).toBeHidden();

    await page.getByRole("button", { name: "Load Waves…" }).click();
    await expect(traces).toHaveCount(1);
    await expect(graph.locator('[data-waveform-trace="CLK"]')).toBeAttached();
    await expect(source).toHaveText(
      "Waveform file other-testbench.raw (manual selection)",
    );
    await expect(diagnostics.locator("pre")).toContainText(
      "other-testbench.raw: Missing signal, sweep or dataset for xstage.out",
    );
    await expect(diagnostics.locator("pre")).toContainText(
      "other-testbench.raw: Missing signal, sweep or dataset for v(DATA[0])",
    );
    await expect(automatic).toBeEnabled();

    await page.getByRole("button", { name: "Reload" }).click();
    await expect(automatic).toBeEnabled();
    await expect(traces).toHaveCount(1);
    await graph.click();
    await expect(source).toHaveText(
      "Waveform file other-testbench.raw (manual selection)",
    );
    await automatic.click();
    await expect(traces).toHaveCount(3);
    await expect(source).toHaveText("Waveform file wave.tran.raw");
    await expect(diagnostics).toBeHidden();
    await expect(automatic).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const { scenario, rawFile, fallback, warning } of [
  {
    scenario: "a missing Tcl source even when a conventional file exists",
    rawFile: '"[source missing.tcl]"',
    fallback: "local",
    warning: "Cannot evaluate Tcl rawfile [source missing.tcl]",
  },
  {
    scenario: "an empty Tcl result even when a conventional file exists",
    rawFile: String.raw`"[set missing \{\}]"`,
    fallback: "local",
    warning: "Tcl rawfile returned no waveform path",
  },
  {
    scenario:
      "a missing Tcl-selected file even when a conventional file exists",
    rawFile: '"[file join [xschem get current_dirname] missing.eye.raw]"',
    fallback: "local",
    warning: "missing.eye.raw returned by Tcl rawfile",
  },
  {
    scenario: "a missing literal rawfile even when a conventional file exists",
    rawFile: "missing.raw",
    fallback: "local",
    warning: "Cannot find waveform file missing.raw",
  },
  {
    scenario: "a Tcl-selected waveform that points outside the allowed roots",
    rawFile: rawFileExpression,
    fallback: "outside",
    warning: "wave.tran.raw returned by Tcl rawfile",
  },
]) {
  test(`reports ${scenario}`, async ({ page }) => {
    const temporary = await mkdtemp(join(tmpdir(), "xschem-wave-unresolved-"));
    try {
      const workspace = join(temporary, "workspace");
      await mkdir(workspace);
      const schematic = join(workspace, "wave.sch");
      const conventional = join(workspace, "wave.tran.raw");
      await writeFile(
        schematic,
        `B 2 0 0 800 300 {flags=graph rawfile=${rawFile} node=out sim_type=tran x1=0 x2=1 y1=0 y2=2}`,
      );
      if (fallback === "local") {
        await writeFile(conventional, asciiTransient(["v(out)"]));
      } else if (fallback === "outside") {
        const outside = join(temporary, "outside.raw");
        await writeFile(outside, asciiTransient(["v(out)"]));
        await symlink(outside, conventional);
      }
      const { errors } = await openViewer(page, schematic, [workspace]);
      const diagnostics = page.locator("#diagnostics");
      await expect(diagnostics).toHaveJSProperty("open", true);
      await expect(diagnostics.locator("pre")).toContainText(warning);
      await expect(page.locator('[data-waveform-graph="0"]')).toContainText(
        "Waveform load failed",
      );
      await expect(page.locator("[data-waveform-trace]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Load Waves…" }),
      ).toBeEnabled();
      expect(errors).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

test("loads nested symbols relative to their source and navigates distinct hierarchies", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem viewer # "));
  try {
    const workspace = join(temporary, "workspace");
    const library = join(temporary, "workspace-library");
    const schematic = join(workspace, "schematic");
    await mkdir(join(library, "nested"), { recursive: true });
    await mkdir(schematic, { recursive: true });
    await writeFile(
      join(schematic, "top.sch"),
      "C {nested/block.sym} 0 0 0 0 {name=X1}\nC {annotation.sch} 200 0 0 0 {name=NOTE}",
    );
    await writeFile(
      join(library, "nested", "block.sym"),
      'K {type=subcircuit template="name=DEFAULT model=DEFAULT_MODEL"}\nC {leaf.sym} 0 0 0 0 {name=INNER}\nT {@name @model} 0 20 0 0 0.2 0.2 {}',
    );
    await writeFile(
      join(library, "nested", "leaf.sym"),
      "K {type=primitive}\nL 4 0 0 50 0 {}\nT {tcleval([expr 2+3])} 0 10 0 0 0.2 0.2 {}",
    );
    await writeFile(
      join(library, "nested", "block.sch"),
      "T {Child schematic} 0 0 0 0 0.2 0.2 {}\nC {leaf.sym} 0 30 0 0 {name=DEVICE}",
    );
    await writeFile(
      join(library, "annotation.sch"),
      "T {@name annotation} 0 0 0 0 0.2 0.2 {}",
    );
    await writeFile(
      join(library, "nested", "leaf.sch"),
      "T {Leaf schematic} 0 0 0 0 0.2 0.2 {}",
    );
    const { requests, errors } = await openViewer(
      page,
      join(schematic, "top.sch"),
      [workspace, library],
    );
    await expect(page.locator("#diagnostics")).toBeHidden();
    await expect(page.locator("svg")).toContainText("X1 DEFAULT_MODEL");
    await expect(page.locator("svg")).toContainText("NOTE annotation");
    await expect(page.locator('g[data-symbol="leaf.sym"]')).toContainText("5");
    await expect(page.locator('g[data-symbol="leaf.sym"] line')).toHaveCount(1);
    const stack = page.locator("#file-stack li");
    const up = page.getByRole("button", { name: "Up", exact: true });
    const topPath = join("schematic", "top.sch");
    const blockPath = join(library, "nested", "block.sch");
    const leafPath = join(library, "nested", "leaf.sch");
    await expect(stack).toHaveText([topPath]);
    await expect(up).toBeDisabled();
    await page.locator('g[data-symbol="nested/block.sym"] > text').dblclick();
    await expect(stack).toHaveText([topPath, blockPath]);
    await expect(page.locator("svg")).toContainText("Child schematic");
    await page.locator('g[data-symbol="leaf.sym"] > text').dblclick();
    await expect(stack).toHaveText([topPath, blockPath, leafPath]);
    await expect(stack.last()).toHaveAttribute("aria-current", "page");
    await writeFile(leafPath, "T {Reloaded leaf} 0 0 0 0 0.2 0.2 {}");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.locator("svg")).toContainText("Reloaded leaf");
    await expect(stack).toHaveText([topPath, blockPath, leafPath]);
    await up.click();
    await expect(stack).toHaveText([topPath, blockPath]);
    await page.getByRole("button", { name: "Top", exact: true }).click();
    await expect(stack).toHaveText([topPath]);
    await expect(up).toBeDisabled();
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(
      requests.some((request) => request.reference.endsWith(".sch.sym")),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("evaluates Xschem expressions in symbol labels with per-instance attributes", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-label-expressions-"));
  try {
    const schematic = join(temporary, "top.sch");
    await writeFile(
      schematic,
      `T {Example: expr(2 + 3)} 0 -40 0 0 0.2 0.2 {}
C {channel.sym} 0 0 0 0 {name=DEFAULT}
C {channel.sym} 0 80 0 0 {name=OVERRIDE LS=68n}
C {channel.sym} 0 160 0 0 {name=INVALID LS=unavailable}`,
    );
    await writeFile(
      join(temporary, "channel.sym"),
      `K {type=subcircuit template="name=CHANNEL LS=17n CC=1.7p"}
T {@name} 0 0 0 0 0.2 0.2 {}
T {Z₀ = expr(sqrt(@LS / @CC )) Ω} 0 15 0 0 0.23 0.23 {hcenter=true}
T {Gain: expr('log(1e-3 * 1Meg)') dB, scale: expr(1 / 2^2^2)} 0 30 0 0 0.2 0.2 {}`,
    );
    const { errors } = await openViewer(page, schematic, [temporary]);
    const symbols = page.locator('g[data-symbol="channel.sym"]');
    const impedance = symbols.getByText(/^Z₀ = /);
    await expect(impedance).toHaveText([
      "Z₀ = 100 Ω",
      "Z₀ = 200 Ω",
      "Z₀ = expr(sqrt(unavailable / 1.7p )) Ω",
    ]);
    await expect(impedance.first()).toHaveAttribute("text-anchor", "middle");
    await expect(symbols.getByText("Gain: 3 dB, scale: 0.0625")).toHaveCount(3);
    await expect(page.locator("svg > text")).toHaveText("Example: expr(2 + 3)");
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("renders per-instance embedded symbols, including nested bodies and local references", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-embedded-"));
  try {
    await mkdir(join(temporary, "library"));
    const drawing = (width: number, model: string): string => `[
K {type=primitive template="name=DEFAULT model=${model}"}
L 4 0 0 ${width} 0 {}
T {@name @model} 0 -20 0 0 0.2 0.2 {}
C {leaf.sym} 0 20 0 0 {name=LEAF}
C {nested.sym} 0 40 0 0 {name=NESTED embed=true}
[
K {type=primitive}
T {@name} 0 0 0 0 0.2 0.2 {}
]
]`;
    await writeFile(
      join(temporary, "top.sch"),
      `C {inline.sym} 20 20 1 1 {name=FIRST model=INSTANCE embed=true}
${drawing(25, "DEFAULT_ONE")}
C {inline.sym} 150 20 0 0 {name=SECOND embed=true}
${drawing(60, "DEFAULT_TWO")}
C {library/wrapper.sym} 300 20 0 0 {name=WRAPPER}`,
    );
    // A same-name disk file must not replace the embedded definition.
    await writeFile(
      join(temporary, "inline.sym"),
      "T {WRONG FILE} 0 0 0 0 0.2 0.2 {}",
    );
    await writeFile(join(temporary, "leaf.sym"), "L 4 0 0 10 0 {}");
    await writeFile(join(temporary, "library/leaf.sym"), "L 4 0 0 15 0 {}");
    await writeFile(
      join(temporary, "library/inline.sch"),
      `v {xschem version=3.4.7 file_version=1.2}
* Detached license line
}
T {Library schematic} 0 0 0 0 0.2 0.2 {}`,
    );
    await writeFile(
      join(temporary, "library/wrapper.sym"),
      `C {inline.sym} 0 0 0 0 {name=THIRD embed=true}\n${drawing(90, "DEFAULT_THREE")}`,
    );
    const { requests, errors } = await openViewer(
      page,
      join(temporary, "top.sch"),
      [temporary, join(temporary, "library")],
    );
    await expect(page.locator("#diagnostics")).toBeHidden();
    const embedded = page.locator(
      'g[data-symbol="inline.sym"][data-embedded="true"]',
    );
    await expect(embedded).toHaveCount(3);
    await expect(embedded.nth(0)).toContainText("FIRST INSTANCE");
    await expect(embedded.nth(0)).toHaveAttribute(
      "transform",
      "translate(20,20) rotate(90) scale(-1, 1)",
    );
    await expect(embedded.nth(1)).toContainText("SECOND DEFAULT_TWO");
    await expect(embedded.nth(2)).toContainText("THIRD DEFAULT_THREE");
    for (const [index, width] of [25, 60, 90].entries()) {
      await expect(
        embedded.nth(index).locator(":scope > line"),
      ).toHaveAttribute("x2", String(width));
    }
    await expect(
      page.locator('g[data-symbol="nested.sym"][data-embedded="true"]'),
    ).toHaveCount(3);
    await expect(
      embedded.nth(2).locator('g[data-symbol="leaf.sym"] > line'),
    ).toHaveAttribute("x2", "15");
    expect(
      requests.some((request) =>
        ["inline.sym", "nested.sym"].includes(request.reference),
      ),
    ).toBe(false);
    await embedded.first().locator(":scope > text").dblclick();
    await expect(page.locator("#file-stack li")).toHaveText([
      "top.sch",
      join("library", "inline.sch"),
    ]);
    await expect(page.locator("svg")).toContainText("Library schematic");
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reuses a single embedded definition for matching instances in the same drawing", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-shared-embedded-"));
  try {
    const schematic = join(temporary, "top.sch");
    await writeFile(
      schematic,
      `C {shared.sym} 0 0 0 0 {name=BEFORE}
C {shared.sym} 100 0 0 0 {name=OWNER embed=true}
[
v {xschem version=3.4.7 file_version=1.2}
K {type=primitive template="name=DEFAULT model=FILTER"}
L 4 0 0 25 0 {}
T {@name @model} 0 -20 0 0 0.2 0.2 {}
]
C {shared.sym} 200 0 0 0 {name=AFTER model=OVERRIDE embed=true}`,
    );
    const { requests, errors } = await openViewer(page, schematic, [temporary]);
    const components = page.locator('g[data-symbol="shared.sym"]');
    await expect(components.locator(":scope > text")).toHaveText([
      "BEFORE FILTER",
      "OWNER FILTER",
      "AFTER OVERRIDE",
    ]);
    await expect(
      page.locator('g[data-symbol="shared.sym"][data-embedded="true"] > line'),
    ).toHaveCount(3);
    await expect(page.locator("#diagnostics")).toBeHidden();
    expect(requests.some((request) => request.reference === "shared.sym")).toBe(
      false,
    );
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("shows missing-symbol diagnostics and reloads changed files", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-missing-"));
  try {
    await writeFile(
      join(temporary, "top.sch"),
      "C {missing.sym} 0 0 0 0 {name=X1}",
    );
    await openViewer(page, join(temporary, "top.sch"), [temporary]);
    await expect(page.locator("#diagnostics")).toContainText("Searched:");
    await expect(page.locator("g[data-missing]")).toHaveCount(1);
    await page.locator("g[data-missing] > text").click();
    await expect(page.locator("#selection-details dd")).toHaveText([
      "missing.sym",
      "(0, 0)",
      "0°",
      "false",
    ]);
    const properties = page.getByRole("table", { name: "Properties" });
    await expect(properties.getByRole("rowheader")).toHaveText("name");
    await expect(properties.getByRole("cell")).toHaveText("X1");
    await writeFile(
      join(temporary, "missing.sym"),
      "T {Found after reload} 0 0 0 0 0.2 0.2 {}",
    );
    await page.locator("#reload").click();
    await expect(page.locator("svg")).toContainText("Found after reload");
    await expect(page.locator("#diagnostics")).toBeHidden();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("hides source instance text while drawing source geometry and schematic labels", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-hidden-text-"));
  try {
    await writeFile(
      join(temporary, "top.sch"),
      `C {vsource.sym} 0 0 0 0 {name=VD0 value="PWL(0 0 1n 1)" hide_texts=true}
C {vsource.sym} 100 0 0 0 {name=VD1 value=1.2 hide_texts=false}
C {vsource.sym} 200 0 0 0 {name=VD2 value=0 hide_texts=YES}
T {VD0: DIN[0]} 0 -25 0 0 0.2 0.2 {}`,
    );
    await writeFile(
      join(temporary, "vsource.sym"),
      `K {type=vsource}
L 4 0 -30 0 30 {}
T {@name} 20 -15 0 0 0.2 0.2 {}
T {@value} 20 5 0 0 0.2 0.2 {}`,
    );
    const { errors } = await openViewer(page, join(temporary, "top.sch"), [
      temporary,
    ]);
    await expect(page.locator("#diagnostics")).toBeHidden();
    const sources = page.locator('g[data-symbol="vsource.sym"]');
    await expect(sources.locator("line")).toHaveCount(3);
    await expect(sources.nth(0).locator("text")).toHaveCount(0);
    await expect(sources.nth(1).locator("text")).toHaveText(["VD1", "1.2"]);
    await expect(sources.nth(2).locator("text")).toHaveCount(0);
    await expect(page.locator("svg > text")).toHaveText("VD0: DIN[0]");
    expect(errors).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("inspects symbols and primitives while preserving pan and hierarchy navigation", async ({
  page,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), "xschem-symbol-hit-"));
  try {
    const properties =
      'name=V1 hide_texts=true\nvalue="PWL(0 0 1n 1)"\nexpr="\\{VIN\\}"';
    await writeFile(
      join(temporary, "top.sch"),
      "C {source.sym} 30 40 1 1 {" +
        properties +
        "}\n" +
        "C {source.sym} 115.5 -40 3 0 {name=V2 hide_texts=true}\n" +
        "N 0 80 60 80 {lab=VIN}",
    );
    await writeFile(
      join(temporary, "source.sym"),
      "L 4 0 -30 0 30 {}\nA 4 0 0 15 0 360 {}\nT {@name} 20 0 0 0 0.2 0.2 {}",
    );
    await writeFile(
      join(temporary, "source.sch"),
      "T {Differential channel loss} -500 -210 0 0 0.5 0.5 {layer=3}\n" +
        "T {Plain label} -450 -60 1 1 0.3 0.2 {}",
    );
    const { requests } = await openViewer(page, join(temporary, "top.sch"), [
      temporary,
    ]);
    const symbols = page.locator('g[data-symbol="source.sym"]');
    const symbol = symbols.first();
    // This point is inside the rotated and mirrored symbol, clear of its line and circle.
    const interior = (target = symbol) =>
      target.evaluate((group) => {
        const { x, y } = new DOMPoint(8, 4).matrixTransform(
          (group as SVGGElement).getScreenCTM()!,
        );
        return { x, y };
      });
    const before = await interior();
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x + 40, before.y, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await interior()).x)
      .toBeGreaterThan(before.x);
    const stack = page.locator("#file-stack li");
    await expect(stack).toHaveText(["top.sch"]);
    const sidebar = page.getByRole("complementary");
    const heading = sidebar.getByRole("heading", { level: 2 });
    await expect(heading).toHaveText("Attributes");
    const table = sidebar.getByRole("table", { name: "Properties" });
    await expect(table).toBeHidden();

    const after = await interior();
    await page.mouse.click(after.x, after.y);
    await expect(symbol).toHaveAttribute("data-selected", "");
    await expect(heading).toHaveText("Component");
    await expect(sidebar.locator("#selection-name")).toHaveText("V1");
    await expect(sidebar.locator("dt")).toHaveText([
      "Symbol",
      "Coordinates (X, Y)",
      "Rotation",
      "Flip",
    ]);
    await expect(sidebar.locator("dd")).toHaveText([
      "source.sym",
      "(30, 40)",
      "90°",
      "true",
    ]);
    await expect(table.getByRole("columnheader")).toHaveText(["Key", "Value"]);
    await expect(table.getByRole("rowheader")).toHaveText([
      "name",
      "hide_texts",
      "value",
      "expr",
    ]);
    await expect(table.getByRole("cell")).toHaveText([
      "V1",
      "true",
      "PWL(0 0 1n 1)",
      "{VIN}",
    ]);
    await expect(stack).toHaveText(["top.sch"]);
    expect(requests.some(({ reference }) => reference === "source.sch")).toBe(
      false,
    );

    const other = symbols.last();
    const otherPoint = await interior(other);
    await page.mouse.move(otherPoint.x, otherPoint.y);
    await page.mouse.down();
    await expect(other).toHaveCSS("outline-style", "none");
    await page.mouse.move(otherPoint.x + 1, otherPoint.y);
    await page.mouse.up();
    await expect(sidebar.locator("dd")).toHaveText([
      "source.sym",
      "(115.5, -40)",
      "270°",
      "false",
    ]);
    await expect(table.getByRole("cell")).toHaveText(["V2", "true"]);
    await expect(other).toHaveAttribute("data-selected", "");
    await expect(page.locator("svg [data-selected]")).toHaveCount(1);

    const wire = page.locator('[data-schematic-object="Wire"]');
    const point = await wire.evaluate((line) => {
      const { x, y } = new DOMPoint(30, 80).matrixTransform(
        (line as SVGLineElement).getScreenCTM()!,
      );
      return { x, y };
    });
    await page.mouse.click(point.x, point.y);
    await expect(heading).toHaveText("Wire");
    await expect(table.getByRole("rowheader")).toHaveText("lab");
    await expect(table.getByRole("cell")).toHaveText("VIN");
    await expect(sidebar.locator("#selection-details")).toBeHidden();
    await expect(other).not.toHaveAttribute("data-selected", "");
    await page.locator("main").click({ position: { x: 4, y: 4 } });
    await expect(table).toBeHidden();
    await symbol.focus();
    await page.keyboard.press("Space");
    await expect(symbol).toHaveAttribute("data-selected", "");
    await page.keyboard.press("Escape");
    await expect(table).toBeHidden();
    await expect(heading).toHaveText("Attributes");

    const child = await interior();
    await page.mouse.dblclick(child.x, child.y);
    await expect(stack).toHaveText(["top.sch", "source.sch"]);
    await expect(table).toBeHidden();
    await page.getByText("Differential channel loss", { exact: true }).click();
    await expect(heading).toHaveText("Text");
    await expect(sidebar.locator("#selection-name")).toBeHidden();
    await expect(sidebar.locator("dt")).toHaveText([
      "Text",
      "Coordinates (X, Y)",
      "Rotation",
      "Flip",
      "Scale (X, Y)",
    ]);
    await expect(sidebar.locator("dd")).toHaveText([
      "Differential channel loss",
      "(-500, -210)",
      "0°",
      "false",
      "(0.5, 0.5)",
    ]);
    await expect(table.getByRole("rowheader")).toHaveText("layer");
    await expect(table.getByRole("cell")).toHaveText("3");
    await page.getByText("Plain label", { exact: true }).click();
    await expect(sidebar.locator("dd")).toHaveText([
      "Plain label",
      "(-450, -60)",
      "90°",
      "true",
      "(0.3, 0.2)",
    ]);
    await expect(table).toBeHidden();
    await expect(sidebar.getByText("No properties set.")).toBeVisible();
    expect(
      requests.filter(({ reference }) => reference === "source.sch"),
    ).toHaveLength(1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
