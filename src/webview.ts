import panzoom from "panzoom";
import { HostLibraryLoader } from "./bridge";
import type { LoadedFile, WaveformAction, WaveGraphResult } from "./protocol";
import {
  drawGraph,
  graphsIn,
  addGraphLayer,
  type Axis,
  type DrawnGraph,
  type Graph,
  type GraphViewport,
} from "../../xschem-viewer/src/waveforms/graph";
import type { Drawing } from "../../xschem-viewer/src/parser/xschem-parser";
import {
  SVGRenderer,
  type DrawnObject,
} from "../../xschem-viewer/src/render/SVGRenderer";
import { colors } from "../../xschem-viewer/src/render/colors";
import "./webview.css";

const svg = document.querySelector<SVGSVGElement>("svg")!;
const main = document.querySelector("main")!;
const status = document.querySelector<HTMLDivElement>("#status")!;
const diagnostics = document.querySelector<HTMLDetailsElement>("#diagnostics")!;
const up = document.querySelector<HTMLButtonElement>("#up")!;
const loadWaves = document.querySelector<HTMLButtonElement>("#load-waves")!;
const automaticWaves =
  document.querySelector<HTMLButtonElement>("#automatic-waves")!;
const fileStack = document.querySelector<HTMLOListElement>("#file-stack")!;
const attributes = document.querySelector<HTMLElement>("#attributes")!;
const attributesHeading = document.querySelector("#attributes-heading")!;
const selectionName =
  document.querySelector<HTMLParagraphElement>("#selection-name")!;
const selectionDetails =
  document.querySelector<HTMLDListElement>("#selection-details")!;
const selectionProperties = document.querySelector<HTMLElement>(
  "#selection-properties",
)!;
const propertyTable =
  document.querySelector<HTMLTableElement>("#property-table")!;
const propertyRows = propertyTable.tBodies[0];
const noProperties =
  document.querySelector<HTMLParagraphElement>("#no-properties")!;
const waveformControls = document.querySelector<HTMLElement>("#waveform-view")!;
const waveformSource = document.querySelector<HTMLElement>("#waveform-source")!;
const linkX = document.querySelector<HTMLInputElement>("#link-x")!;
const linkStatus = document.querySelector<HTMLElement>(
  "#waveform-link-status",
)!;
const resetWaveView =
  document.querySelector<HTMLButtonElement>("#reset-wave-view")!;
const waveformAxis =
  document.querySelector<HTMLSelectElement>("#waveform-axis")!;
const stepButtons = [
  ...waveformControls.querySelectorAll<HTMLButtonElement>(
    "[data-wave-pan], [data-wave-zoom]",
  ),
];
const top = document.body.dataset.document!;
const graphLineWidthMult = Number(document.body.dataset.graphLineWidthMult);
const loader = new HostLibraryLoader();
const renderer = new SVGRenderer(loader, colors);
const graphObjects = new WeakMap<Element, DrawnObject>();
let selected: DrawnObject | undefined;
const stack: Pick<LoadedFile, "uri" | "displayPath">[] = [];
interface GraphView {
  graph: Graph;
  viewport: GraphViewport;
  saved?: DrawnGraph["ranges"];
  result?: WaveGraphResult;
  drawn?: DrawnGraph;
}

interface WaveformView {
  uri: string;
  layer: SVGGElement;
  graphs: GraphView[];
  linkX: boolean;
  fileLoading: boolean;
  pending: Set<number>;
  dirty: Set<number>;
  timer?: number;
  frame?: number;
}

let activeGraphs: WaveformView | undefined;
type ViewAxis = keyof GraphViewport;

let waveRequest = 0;
let busy = false;
let press:
  | { id: number; x: number; y: number; object?: DrawnObject; dragged: boolean }
  | undefined;
let clickSequencePanned = false;
const zoom = panzoom(svg, {
  maxZoom: 10,
  minZoom: 0.02,
  zoomDoubleClickSpeed: 1,
});
svg.addEventListener(
  "dblclick",
  (event) => {
    // A drag ending over the same symbol can count as one of the clicks.
    if (clickSequencePanned) event.stopPropagation();
  },
  { capture: true },
);

function select(object?: DrawnObject): void {
  if (selected === object) return;
  const previous = selected;
  selected = object;
  previous?.elements.forEach((element) =>
    element.removeAttribute("data-selected"),
  );
  object?.elements.forEach((element) =>
    element.setAttribute("data-selected", ""),
  );
  updateWaveformControls();
  const item = object?.item;
  if (previous?.item === item) return;

  attributesHeading.textContent = object?.elements[0].hasAttribute(
    "data-waveform-graph",
  )
    ? "Waveform"
    : (item?.type ?? "Attributes");
  const instanceName =
    item?.type === "Component" ? item.properties.name : undefined;
  selectionName.hidden = Boolean(item && !instanceName);
  selectionName.toggleAttribute("data-active", Boolean(instanceName));
  selectionName.textContent = item
    ? (instanceName ?? "")
    : "Select an element to see its attributes.";

  selectionDetails.replaceChildren();
  const field = (label: string, value: string) => {
    const name = document.createElement("dt");
    const detail = document.createElement("dd");
    name.textContent = label;
    detail.textContent = value;
    selectionDetails.append(name, detail);
  };
  if (item?.type === "Component" || item?.type === "Text") {
    const isComponent = item.type === "Component";
    if (isComponent) {
      field("Symbol", item.symbolReference);
    } else {
      field("Text", item.text);
    }
    field("Coordinates (X, Y)", `(${item.x}, ${item.y})`);
    field("Rotation", `${item.rotation * 90}°`);
    field("Flip", String(Boolean(isComponent ? item.flip : item.mirror)));
    if (item.type === "Text") {
      field("Scale (X, Y)", `(${item.hSize}, ${item.vSize})`);
    }
  }
  if (item?.type === "Rectangle") {
    field("Layer", String(item.layer));
    field("Start (X, Y)", `(${item.x1}, ${item.y1})`);
    field("End (X, Y)", `(${item.x2}, ${item.y2})`);
  }
  selectionDetails.hidden = !selectionDetails.childElementCount;
  selectionProperties.hidden = !item;
  propertyRows.replaceChildren();
  for (const [key, value] of Object.entries(item?.properties ?? {})) {
    if (value === undefined) continue;
    const row = propertyRows.insertRow();
    const header = document.createElement("th");
    header.scope = "row";
    header.textContent = key;
    row.append(header);
    row.insertCell().textContent = value;
  }
  propertyTable.hidden = !propertyRows.rows.length;
  noProperties.hidden = !propertyTable.hidden;
  attributes.scrollTop = 0;
}

function objectAt(target: EventTarget | null): DrawnObject | undefined {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== svg && element !== main;
    element = element.parentElement
  ) {
    const object = renderer.objectFor(element) ?? graphObjects.get(element);
    if (object) return object;
  }
}

main.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  press = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    object: objectAt(event.target),
    dragged: false,
  };
});

function trackDrag(event: PointerEvent): void {
  if (press?.id !== event.pointerId) return;
  // Panzoom starts on any movement. Allow a little pointer drift during a click.
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
    press.dragged = true;
  }
}

window.addEventListener(
  "pointermove",
  (event) => {
    if (event.buttons) trackDrag(event);
  },
  { capture: true },
);
window.addEventListener("pointerup", trackDrag, { capture: true });
window.addEventListener(
  "pointercancel",
  (event) => {
    if (press?.id === event.pointerId) press = undefined;
  },
  { capture: true },
);

main.addEventListener(
  "click",
  (event) => {
    const pointer = event.detail > 0 ? press : undefined;
    press = undefined;
    if (event.detail > 0) {
      clickSequencePanned =
        pointer?.dragged === true || (event.detail > 1 && clickSequencePanned);
    }
    if (pointer?.dragged || document.body.dataset.ready !== "true") return;
    // The browser may target a common ancestor if the pointer moved off a thin stroke.
    const start = pointer?.object;
    select(start?.elements[0].isConnected ? start : objectAt(event.target));
  },
  { capture: true },
);

main.addEventListener("keydown", (event) => {
  if (event.key !== " " || document.body.dataset.ready !== "true") return;
  const object = objectAt(event.target);
  if (object) {
    event.preventDefault();
    select(object);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") select();
});
document.addEventListener(
  "keydown",
  (event) => {
    if (
      selectedGraph() === undefined ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.target instanceof Element &&
        event.target.closest("input, select, textarea, [contenteditable]"))
    )
      return;
    const button = stepButtons.find(
      (step) => step.getAttribute("aria-keyshortcuts") === event.key,
    );
    if (!button) return;
    // Handle graph arrows before the schematic's panzoom listener sees them.
    event.preventDefault();
    event.stopPropagation();
    button.click();
  },
  { capture: true },
);

function fit(): void {
  const box = svg.viewBox.baseVal;
  const scale = Math.min(
    main.clientWidth / Math.max(box.width + 40, 1),
    main.clientHeight / Math.max(box.height + 40, 1),
  );
  zoom.zoomAbs(0, 0, scale);
  zoom.moveTo(
    (main.clientWidth - box.width * scale) / 2,
    (main.clientHeight - box.height * scale) / 2,
  );
}

function redrawGraphs(view: WaveformView, indices: Iterable<number>): void {
  for (const index of indices) {
    const state = view.graphs[index];
    const previous = state.drawn?.element;
    const wasFocused = previous && document.activeElement === previous;
    state.drawn = drawGraph(
      view.layer,
      state.graph,
      index,
      graphLineWidthMult,
      state.result,
      {
        x: state.viewport.x ?? state.saved?.x,
        y: state.viewport.y ?? state.saved?.y,
      },
    );
    if (state.result?.series.length) state.saved ??= state.drawn.ranges;
    const { element } = state.drawn;
    previous?.replaceWith(element);
    const object = { item: state.graph.item, elements: [element] };
    graphObjects.set(element, object);
    if (selected?.item === state.graph.item) select(object);
    if (wasFocused) element.focus({ preventScroll: true });
  }
}

function selectedGraph(): number | undefined {
  const index = selected?.elements[0].getAttribute("data-waveform-graph");
  return index == null ? undefined : Number(index);
}

function linkKey({ graph, result }: GraphView): string | undefined {
  if (graph.unlocked || !result?.series.length) return;
  const sweep = result.series[0].sweep.toLowerCase();
  if (!result.series.every((trace) => trace.sweep.toLowerCase() === sweep))
    return;
  return JSON.stringify([graph.request.analysis, graph.request.logX, sweep]);
}

function xPeers(view: WaveformView, index: number): number[] {
  const key = view.linkX ? linkKey(view.graphs[index]) : undefined;
  if (key === undefined) return [index];
  return view.graphs.flatMap((state, peer) =>
    peer === index || linkKey(state) === key ? [peer] : [],
  );
}

function updateWaveformControls(): void {
  const view = activeGraphs;
  loadWaves.hidden = !view;
  loadWaves.disabled = Boolean(view?.fileLoading || view?.pending.size);
  automaticWaves.hidden = !view?.graphs.some(
    ({ result }) => result?.source?.manual,
  );
  automaticWaves.disabled = loadWaves.disabled;
  const index = selectedGraph();
  if (!view || index === undefined || !view.graphs[index]) {
    waveformControls.hidden = true;
    return;
  }
  const state = view.graphs[index];
  const source = state.result?.source;
  waveformControls.hidden = false;
  waveformSource.hidden = !source;
  waveformSource.textContent = source
    ? `Waveform file ${source.basename}${source.manual ? " (manual selection)" : ""}`
    : "";
  linkX.checked = view.linkX && !state.graph.unlocked;
  linkX.disabled = state.graph.unlocked;
  linkStatus.hidden = !state.graph.unlocked;
  const canInteract = !view.fileLoading && Boolean(state.result?.series.length);
  waveformAxis.disabled = !canInteract;
  for (const button of stepButtons) button.disabled = !canInteract;
  resetWaveView.disabled =
    view.fileLoading ||
    (!state.viewport.y &&
      xPeers(view, index).every((peer) => !view.graphs[peer].viewport.x));
}

function axisRange(state: GraphView, axis: ViewAxis): Axis {
  return state.viewport[axis] ?? state.drawn!.ranges[axis];
}

function scheduleRedraw(view: WaveformView, index: number): void {
  view.dirty.add(index);
  if (view.frame !== undefined) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = undefined;
    if (view !== activeGraphs) return;
    redrawGraphs(view, view.dirty);
    view.dirty.clear();
  });
}

function scheduleSamples(view: WaveformView, index: number): void {
  view.pending.add(index);
  clearTimeout(view.timer);
  view.timer = window.setTimeout(() => {
    if (view === activeGraphs && view.pending.size)
      void showWaveforms(view, "load", [...view.pending]);
  }, 120);
}

function setRange(
  view: WaveformView,
  index: number,
  axis: ViewAxis,
  range: Axis,
): void {
  const span = range[1] - range[0];
  if (
    !Number.isFinite(span) ||
    Math.abs(span) <=
      Math.max(Math.abs(range[0]), Math.abs(range[1])) * Number.EPSILON
  )
    return;
  for (const peer of axis === "x" ? xPeers(view, index) : [index]) {
    const state = view.graphs[peer];
    const current = axisRange(state, axis);
    // Linked plots share the interval while keeping their axis direction.
    const next: Axis =
      peer === index || span > 0 === current[1] > current[0]
        ? range
        : [range[1], range[0]];
    if (current[0] === next[0] && current[1] === next[1]) continue;
    state.viewport[axis] = next;
    scheduleRedraw(view, peer);
    if (axis === "x") scheduleSamples(view, peer);
  }
  updateWaveformControls();
}

function transformRange(
  range: Axis,
  scale: number,
  anchor: number,
  shift = 0,
): Axis {
  const span = range[1] - range[0];
  const left = range[0] + (shift + anchor * (1 - scale)) * span;
  return [left, left + span * scale];
}

function showDiagnostics(
  errors: string[],
  warnings: string[] = [],
  waveformErrors: string[] = [],
): void {
  const messages = [...errors, ...new Set([...waveformErrors, ...warnings])];
  diagnostics.hidden = messages.length === 0;
  if (messages.length) {
    diagnostics.open = errors.length > 0 || waveformErrors.length > 0;
    diagnostics.querySelector("summary")!.textContent =
      errors.length && (waveformErrors.length || warnings.length)
        ? "Schematic and waveform diagnostics"
        : errors.length
          ? "Rendering errors"
          : "Waveform diagnostics";
    diagnostics.querySelector("pre")!.textContent = messages.join("\n\n");
  }
  status.textContent = errors.length
    ? `${errors.length} rendering error(s)`
    : "Click to inspect. Double-click a component to open its schematic. Scroll to zoom; drag to pan.";
  if (waveformErrors.length)
    status.textContent += " Waveform loading failed. See diagnostics.";
  else if (warnings.length)
    status.textContent += " Some waveforms could not be loaded.";
}

async function showWaveforms(
  view: WaveformView,
  action: WaveformAction = "load",
  indices?: number[],
): Promise<void> {
  const id = ++waveRequest;
  const changeFile = action !== "load";
  if (!indices) view.fileLoading = true;
  updateWaveformControls();
  const requested = (indices ?? view.graphs.map((_, index) => index)).map(
    (index) => {
      const { graph, viewport } = view.graphs[index];
      const x = changeFile ? undefined : viewport.x;
      return {
        index,
        x,
        request: x
          ? { ...graph.request, xMin: x[0], xMax: x[1] }
          : graph.request,
      };
    },
  );
  let results: WaveGraphResult[] | undefined;
  try {
    const response = await loader.waveforms(
      view.uri,
      requested.map(({ request }) => request),
      action,
    );
    if ("error" in response) throw new Error(response.error);
    if ("graphs" in response) results = response.graphs;
  } catch (error) {
    results = requested.map(() => ({
      series: [],
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  if (view !== activeGraphs || id !== waveRequest) return;
  if (!indices) view.fileLoading = false;
  if (results) {
    for (const [i, { index, x }] of requested.entries()) {
      const state = view.graphs[index];
      // An input event may have changed the range before this reply arrived.
      if (changeFile) {
        state.viewport = {};
        state.saved = undefined;
      } else if (state.viewport.x !== x) {
        continue;
      }
      state.result = results[i];
      view.pending.delete(index);
      scheduleRedraw(view, index);
    }
    showDiagnostics(
      renderer.errors,
      view.graphs.flatMap(({ result }) => result?.warnings ?? []),
      view.graphs.flatMap(({ result }) =>
        result?.error ? [result.error] : [],
      ),
    );
  }
  updateWaveformControls();
}

function addGraphs(resolved: LoadedFile, items: Drawing): void {
  activeGraphs = undefined;
  if (!new URL(resolved.uri).pathname.toLowerCase().endsWith(".sch")) return;
  const graphs = graphsIn(items);
  if (!graphs.length) return;
  const layer = addGraphLayer(svg, graphs);
  activeGraphs = {
    uri: resolved.uri,
    layer,
    graphs: graphs.map((graph) => ({ graph, viewport: {} })),
    linkX: true,
    fileLoading: false,
    pending: new Set(),
    dirty: new Set(),
  };
  redrawGraphs(activeGraphs, graphs.keys());
}

async function show(
  reference: string,
  keep: number,
  from?: string,
): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    loader.clear();
    const resolved = await loader
      .load(reference, from ?? reference)
      .catch((error) => {
        if (from === undefined) throw error;
        status.textContent = `No schematic view for ${reference}`;
        return undefined;
      });
    if (!resolved) return;
    select();
    activeGraphs = undefined;
    updateWaveformControls();
    document.body.dataset.ready = "false";
    diagnostics.hidden = true;
    diagnostics.querySelector("pre")!.textContent = "";
    status.textContent = "Loading…";
    const items = await renderer.render(resolved.uri, svg);
    addGraphs(resolved, items);
    stack.splice(keep, stack.length - keep, {
      uri: resolved.uri,
      displayPath: resolved.displayPath,
    });
    const rows = stack.map(({ displayPath }) => {
      const row = document.createElement("li");
      row.textContent = displayPath;
      row.title = displayPath;
      return row;
    });
    rows.at(-1)!.setAttribute("aria-current", "page");
    fileStack.replaceChildren(...rows);
    fileStack.scrollTop = fileStack.scrollHeight;
    fit();
    showDiagnostics(renderer.errors);
    document.body.dataset.ready = "true";
    if (activeGraphs) void showWaveforms(activeGraphs);
  } catch (error) {
    activeGraphs = undefined;
    updateWaveformControls();
    status.textContent = "Cannot load schematic";
    diagnostics.hidden = false;
    diagnostics.open = true;
    diagnostics.querySelector("pre")!.textContent = String(error);
    document.body.dataset.ready = "error";
  } finally {
    up.disabled = stack.length < 2;
    busy = false;
  }
}

renderer.onComponentClick.listen(({ reference, from }) => {
  void show(reference, stack.length, from);
});
renderer.onLoadComponent.listen((name) => {
  status.textContent = `Loading ${name}…`;
});
up.addEventListener("click", () => {
  const parent = stack.at(-2);
  if (parent) void show(parent.uri, stack.length - 2);
});
document.querySelector("#home")!.addEventListener("click", () => {
  void show(top, 0);
});
document.querySelector("#reload")!.addEventListener("click", () => {
  void show(stack.at(-1)?.uri ?? top, Math.max(0, stack.length - 1));
});
loadWaves.addEventListener("click", () => {
  if (activeGraphs && !busy) void showWaveforms(activeGraphs, "pick");
});
automaticWaves.addEventListener("click", () => {
  if (activeGraphs && !busy) void showWaveforms(activeGraphs, "useAutomatic");
});
linkX.addEventListener("change", () => {
  const view = activeGraphs;
  const index = selectedGraph();
  if (!view || index === undefined || view.graphs[index].graph.unlocked) return;
  view.linkX = linkX.checked;
  updateWaveformControls();
});

resetWaveView.addEventListener("click", () => {
  const view = activeGraphs;
  const index = selectedGraph();
  if (!view || index === undefined || view.fileLoading) return;
  view.graphs[index].viewport.y = undefined;
  scheduleRedraw(view, index);
  for (const peer of xPeers(view, index)) {
    if (!view.graphs[peer].viewport.x) continue;
    view.graphs[peer].viewport.x = undefined;
    scheduleRedraw(view, peer);
    scheduleSamples(view, peer);
  }
  updateWaveformControls();
});

for (const button of stepButtons)
  button.addEventListener("click", () => {
    const view = activeGraphs;
    const index = selectedGraph();
    if (!view || index === undefined || view.fileLoading) return;
    const axis = waveformAxis.value === "y" ? "y" : "x";
    const range = axisRange(view.graphs[index], axis);
    const scale = Number(button.dataset.waveZoom ?? 1);
    const shift = Number(button.dataset.wavePan ?? 0);
    setRange(view, index, axis, transformRange(range, scale, 0.5, shift));
  });

function waveformHit(event: MouseEvent) {
  const view = activeGraphs;
  if (
    !event.altKey ||
    !view ||
    view.fileLoading ||
    !(event.target instanceof Element)
  )
    return;
  const element = event.target.closest("[data-waveform-graph]");
  if (!element) return;
  const index = Number(element.getAttribute("data-waveform-graph"));
  const state = view.graphs[index];
  const drawn = state?.drawn;
  if (!drawn || drawn.element !== element || !state.result?.series.length)
    return;
  const matrix = drawn.element.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix.inverse(),
  );
  const { left, right, top, bottom } = drawn.plot;
  if (point.y < top || point.y > bottom || point.x < 0 || point.x > right)
    return;
  const axis: ViewAxis = point.x < left ? "y" : "x";
  const anchor =
    axis === "x"
      ? (point.x - left) / (right - left)
      : (bottom - point.y) / (bottom - top);
  const pixels =
    axis === "x" ? (right - left) * matrix.a : (bottom - top) * matrix.d;
  return {
    view,
    index,
    axis,
    anchor,
    pixels,
    range: axisRange(state, axis),
    element,
  };
}

main.addEventListener(
  "wheel",
  (event) => {
    const hit = waveformHit(event);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    select(graphObjects.get(hit.element));
    const delta = event.deltaY * (event.deltaMode ? 30 : 1);
    if (delta === 0) return;
    const scale = Math.exp(Math.max(-1, Math.min(1, delta * 0.002)));
    setRange(
      hit.view,
      hit.index,
      hit.axis,
      transformRange(hit.range, scale, hit.anchor),
    );
  },
  { capture: true, passive: false },
);

let waveDrag:
  | (NonNullable<ReturnType<typeof waveformHit>> & {
      id: number;
      start: number;
    })
  | undefined;

main.addEventListener(
  "pointerdown",
  (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const hit = waveformHit(event);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const object = graphObjects.get(hit.element);
    select(object);
    // Pointer capture keeps the drag alive while the SVG graph is redrawn.
    main.setPointerCapture(event.pointerId);
    waveDrag = {
      ...hit,
      id: event.pointerId,
      start: hit.axis === "x" ? event.clientX : event.clientY,
    };
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      object,
      dragged: true,
    };
  },
  { capture: true },
);

main.addEventListener("pointermove", (event) => {
  const drag = waveDrag;
  if (!drag || drag.id !== event.pointerId || drag.view !== activeGraphs)
    return;
  const displacement =
    drag.axis === "x" ? drag.start - event.clientX : event.clientY - drag.start;
  setRange(
    drag.view,
    drag.index,
    drag.axis,
    transformRange(drag.range, 1, 0, displacement / drag.pixels),
  );
});

main.addEventListener("lostpointercapture", (event) => {
  if (waveDrag?.id === event.pointerId) waveDrag = undefined;
});

new ResizeObserver(() => {
  if (!busy) fit();
}).observe(main);
void show(top, 0);
