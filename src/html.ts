function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function webviewHtml(
  documentUri: string,
  baseUri: string,
  cspSource: string,
  nonce: string,
  graphLineWidthMult?: number,
): string {
  const lineWidthMult =
    typeof graphLineWidthMult === "number" &&
    Number.isFinite(graphLineWidthMult) &&
    graphLineWidthMult > 0
      ? graphLineWidthMult
      : 1.4;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${cspSource}; img-src ${cspSource} data: blob:; style-src ${cspSource}; script-src ${cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${attribute(baseUri.replace(/\/?$/, "/"))}">
<title>Xschem Viewer</title>
<link rel="stylesheet" href="assets/webview.css">
<script type="module" nonce="${nonce}" src="assets/webview.js"></script>
</head><body data-document="${attribute(documentUri)}" data-graph-line-width-mult="${lineWidthMult}">
<header><button id="up" disabled>Up</button><button id="home">Top</button><button id="reload">Reload</button><button id="load-waves" hidden>Load Waves…</button><button id="automatic-waves" hidden>Use automatic waveform</button><ol id="file-stack" aria-label="Schematic file stack" role="list"></ol></header>
<div id="status" role="status">Loading…</div>
<details id="diagnostics" hidden><summary>Rendering errors</summary><pre></pre></details>
<div class="workspace">
  <main><svg xmlns="http://www.w3.org/2000/svg" aria-label="Xschem schematic"></svg></main>
  <aside id="attributes" aria-labelledby="attributes-heading">
    <h2 id="attributes-heading" aria-live="polite">Attributes</h2>
    <p id="selection-name" aria-live="polite">Select an element to see its attributes.</p>
    <dl id="selection-details" hidden></dl>
    <section id="waveform-view" aria-labelledby="waveform-view-heading" hidden>
      <h3 id="waveform-view-heading">Waveform view</h3>
      <p id="waveform-source" hidden></p>
      <div class="waveform-buttons">
        <label><input id="link-x" type="checkbox"> Link X</label>
        <button id="reset-wave-view" type="button">Reset to Saved View</button>
      </div>
      <p id="waveform-link-status" hidden>X axis is unlocked in the schematic.</p>
      <div class="waveform-buttons" role="group" aria-label="Pan and zoom waveform">
        <label>Axis <select id="waveform-axis"><option value="x">X</option><option value="y">Y</option></select></label>
        <button type="button" data-wave-pan="-0.2" aria-keyshortcuts="ArrowLeft" aria-label="Pan toward start" title="Pan toward start (Left)">←</button>
        <button type="button" data-wave-pan="0.2" aria-keyshortcuts="ArrowRight" aria-label="Pan toward end" title="Pan toward end (Right)">→</button>
        <button type="button" data-wave-zoom="0.8" aria-keyshortcuts="ArrowUp" aria-label="Zoom waveform in" title="Zoom waveform in (Up)">+</button>
        <button type="button" data-wave-zoom="1.25" aria-keyshortcuts="ArrowDown" aria-label="Zoom waveform out" title="Zoom waveform out (Down)">−</button>
      </div>
      <p class="waveform-hint">Left/Right pan and Up/Down zoom the selected axis. Alt/Option + drag or scroll works on the plot, or on the left axis for Y.</p>
    </section>
    <section id="selection-properties" aria-labelledby="properties-heading" hidden>
      <h3 id="properties-heading">Properties</h3>
      <table id="property-table" aria-labelledby="properties-heading" hidden>
        <thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
        <tbody></tbody>
      </table>
      <p id="no-properties" hidden>No properties set.</p>
    </section>
  </aside>
</div>
</body></html>`;
}
