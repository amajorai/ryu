"use client";

import { useTheme } from "next-themes";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Renders a Mermaid diagram. Used both directly as `<Mermaid chart="..." />`
 * and as the target of the `remarkMdxMermaid` plugin, which rewrites
 * ```mermaid fenced code blocks into this component at build time.
 *
 * Clicking the diagram opens a fullscreen dialog with pan and zoom support.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const currentChartRef = useRef<string | null>(null);
  const { resolvedTheme } = useTheme();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
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
      requestAnimationFrame(() => {
        if (!cancelled && containerRef.current) {
          bindFunctions?.(containerRef.current);
        }
      });
    };

    render().catch(() => {
      if (!cancelled) {
        currentChartRef.current = null;
        setSvg("");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  const openDialog = useCallback(() => {
    dialogRef.current?.showModal();
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
    setDialogOpen(false);
  }, []);

  if (!svg) {
    return (
      <pre className="overflow-x-auto rounded-lg bg-fd-secondary/50 p-4 text-sm">
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <>
      <div
        className="group/my-4 relative flex cursor-pointer justify-center [&_svg]:max-w-full"
        onClick={openDialog}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDialog();
          }
        }}
        ref={containerRef}
        role="button"
        tabIndex={0}
        title="Click to expand diagram"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output is trusted, build-time authored diagram source
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <span className="block text-center text-fd-muted-foreground text-xs opacity-0 transition-opacity group-hover/my-4:opacity-100">
        Click to expand
      </span>
      {dialogOpen ? (
        <MermaidDialog onClose={closeDialog} svg={svg} />
      ) : null}
    </>
  );
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

function MermaidDialog({
  onClose,
  svg,
}: {
  onClose: () => void;
  svg: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
  });

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale((prev) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * delta)));
    },
    [],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startOffsetX: offset.x,
        startOffsetY: offset.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [offset],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset({
      x: dragRef.current.startOffsetX + dx,
      y: dragRef.current.startOffsetY + dy,
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragRef.current.active = false;
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleDialogClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === dialogRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const svgWithKeys = useMemo(() => {
    return svg.replace(
      /<svg/,
      '<svg style="max-width:none;max-height:none"',
    );
  }, [svg]);

  return (
    <dialog
      aria-label="Expanded diagram view"
      className="backdrop:bg-fd-background/80 border-0 bg-transparent p-0 shadow-2xl backdrop:backdrop-blur-sm open:flex open:fixed open:inset-0 open:z-50 open:items-center open:justify-center"
      onClose={handleDialogClose}
      onClick={handleBackdropClick}
      ref={dialogRef}
    >
      <div className="relative flex h-[85vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-xl border border-fd-border bg-fd-background shadow-2xl">
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-fd-border px-4 py-2">
          <span className="font-medium text-fd-muted-foreground text-sm">
            Diagram viewer
          </span>
          <div className="flex items-center gap-2">
            <span className="text-fd-muted-foreground text-xs tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <button
              className="rounded-md bg-fd-secondary px-2 py-1 text-fd-muted-foreground text-xs transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              onClick={resetView}
              type="button"
            >
              Reset
            </button>
            <button
              className="rounded-md bg-fd-secondary px-2 py-1 text-fd-muted-foreground text-xs transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              onClick={() => setScale((s) => Math.min(ZOOM_MAX, s * 1.25))}
              type="button"
            >
              Zoom in
            </button>
            <button
              className="rounded-md bg-fd-secondary px-2 py-1 text-fd-muted-foreground text-xs transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              onClick={() => setScale((s) => Math.max(ZOOM_MIN, s * 0.8))}
              type="button"
            >
              Zoom out
            </button>
            <button
              aria-label="Close diagram viewer"
              className="ml-2 rounded-md bg-fd-secondary p-1 text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              onClick={onClose}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Viewport */}
        <div
          className="flex-1 overflow-hidden"
          onWheel={handleWheel}
          ref={viewportRef}
        >
          <div
            className="flex h-full w-full cursor-grab items-center justify-center active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: "center center",
              transition: dragRef.current.active
                ? "none"
                : "transform 0.1s ease-out",
            }}
          >
            <div
              className="[&_svg]:pointer-events-none [&_svg]:max-w-none"
              dangerouslySetInnerHTML={{ __html: svgWithKeys }}
            />
          </div>
        </div>
      </div>
    </dialog>
  );
}
