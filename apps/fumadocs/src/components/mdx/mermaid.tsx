"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Renders a Mermaid diagram. Used both directly as `<Mermaid chart="..." />`
 * and as the target of the `remarkMdxMermaid` plugin, which rewrites
 * ```mermaid fenced code blocks into this component at build time.
 *
 * Mermaid is dynamically imported so it only ships on pages that contain a
 * diagram, and the theme follows Fumadocs' light/dark switch via next-themes.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const currentChartRef = useRef<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    // Re-render when the chart text OR the theme changes. We do NOT guard on the
    // container being mounted here: on the first pass `svg` is empty so the
    // fallback `<pre>` is shown and the ref'd `<div>` does not exist yet.
    // `mermaid.render()` builds the SVG string off-DOM, so it can run before the
    // container exists; `bindFunctions` is what needs the mounted node, and that
    // runs after `setSvg` swaps in the `<div>`.
    const cacheKey = `${resolvedTheme}:${chart}`;
    if (currentChartRef.current === cacheKey) {
      return;
    }
    currentChartRef.current = cacheKey;

    let cancelled = false;

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "inherit",
        theme: resolvedTheme === "dark" ? "dark" : "default",
      });

      const safeId = `mermaid-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
      const { svg: rendered, bindFunctions } = await mermaid.render(
        safeId,
        chart.replaceAll("\\n", "\n"),
      );
      if (cancelled) {
        return;
      }
      setSvg(rendered);
      // bindFunctions wires up interactive handlers once the SVG is in the DOM.
      // queueMicrotask alone can run before React commits the new `<div>`, so
      // bind on the next animation frame when the container is guaranteed mounted.
      requestAnimationFrame(() => {
        if (!cancelled && containerRef.current) {
          bindFunctions?.(containerRef.current);
        }
      });
    };

    render().catch(() => {
      // Rendering failed (e.g. invalid syntax) - reset so the raw source falls
      // back into view instead of showing nothing, and allow a later retry.
      if (!cancelled) {
        currentChartRef.current = null;
        setSvg("");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) {
    return (
      <pre className="overflow-x-auto rounded-lg border bg-fd-secondary/50 p-4 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div
      className="my-4 flex justify-center [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output is trusted, build-time authored diagram source
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={containerRef}
    />
  );
}
