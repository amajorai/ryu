"use client";
import { ExpandIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useId, useRef, useState } from "react";
import type { CustomRendererProps } from "streamdown";
import { CopyFormatMenu, writeClipboardPayload } from "./copy-format-menu.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";

const DIAGRAM_COPY_OPTIONS = [
	{ id: "mermaid", label: "Copy as Mermaid" },
	{ id: "svg", label: "Copy as SVG" },
	{ id: "png", label: "Copy as PNG" },
] as const;

function svgToPng(svg: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => {
			const canvas = document.createElement("canvas");
			const width = image.naturalWidth || image.width;
			const height = image.naturalHeight || image.height;
			if (!(width > 0 && height > 0)) {
				reject(new Error("Diagram has no measurable size"));
				return;
			}
			const scale = Math.min(2, window.devicePixelRatio || 1);
			canvas.width = Math.ceil(width * scale);
			canvas.height = Math.ceil(height * scale);
			const context = canvas.getContext("2d");
			if (!context) {
				reject(new Error("Could not create a diagram canvas"));
				return;
			}
			context.scale(scale, scale);
			context.drawImage(image, 0, 0, width, height);
			canvas.toBlob((blob) => {
				if (blob) {
					resolve(blob);
					return;
				}
				reject(new Error("Could not encode diagram as PNG"));
			}, "image/png");
		};
		image.onerror = () => reject(new Error("Could not load diagram SVG"));
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
}

/** Hosts with local-only replies can disable network-active response images. */
export function MermaidBlock({
	code,
	isIncomplete,
	wideBlocks,
}: CustomRendererProps & { wideBlocks: boolean }) {
	const id = useId();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const originRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (isIncomplete || !code.trim()) {
			setSvg(null);
			setError(null);
			return;
		}
		let cancelled = false;
		setSvg(null);
		setError(null);

		const renderDiagram = async () => {
			const mermaidModule = await import("mermaid");
			const mermaid = mermaidModule.default;
			const prefersDark =
				globalThis.window !== undefined &&
				isNativeFunction(window.matchMedia) &&
				window.matchMedia("(prefers-color-scheme: dark)").matches;
			mermaid.initialize({
				fontFamily: "inherit",
				securityLevel: "strict",
				startOnLoad: false,
				theme: prefersDark ? "dark" : "default",
			});
			const safeId = `ryu-chat-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
			const rendered = await mermaid.render(
				safeId,
				code.replaceAll("\\n", "\n")
			);
			if (!cancelled) {
				setSvg(rendered.svg);
			}
		};

		renderDiagram().catch((reason) => {
			if (!cancelled) {
				setError(
					reason instanceof Error ? reason.message : "Failed to render diagram"
				);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [code, id, isIncomplete]);

	// The lightbox only shows media URLs the shared policy admits, and that
	// policy refuses `data:image/svg+xml`. Hand it a browser-created object URL
	// for the sanitized SVG instead, revoked when the diagram changes or unmounts.
	const [diagramUrl, setDiagramUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!svg) {
			setDiagramUrl(null);
			return;
		}
		const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
		setDiagramUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [svg]);

	const handleCopy = async (format: string) => {
		if (format === "mermaid") {
			await writeClipboardPayload({ "text/plain": code }, code);
			return;
		}
		if (!svg) {
			throw new Error("Diagram is still rendering");
		}
		if (format === "svg") {
			await writeClipboardPayload(
				{ "image/svg+xml": svg, "text/plain": svg },
				svg
			);
			return;
		}
		if (format === "png") {
			await writeClipboardPayload({ "image/png": await svgToPng(svg) });
		}
	};

	const surfaceClassName = cn(
		"group/mermaid-block relative my-3 flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted/30 p-2",
		wideBlocks && "-mx-4 w-[calc(100%+2rem)] max-w-[calc(100vw-2rem)]"
	);

	if (error) {
		return (
			<div className={surfaceClassName} data-streamdown="mermaid-block">
				<div className="flex items-center justify-between px-1 text-xs">
					<span className="font-mono text-muted-foreground">Mermaid</span>
					<CopyFormatMenu
						ariaLabel="Copy diagram"
						dataTestId="mermaid-copy"
						onCopy={handleCopy}
						options={DIAGRAM_COPY_OPTIONS}
					/>
				</div>
				<p className="px-1 text-status-destructive text-xs">{error}</p>
				<pre className="max-h-56 overflow-auto rounded-lg bg-background/70 p-3 text-xs">
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className={surfaceClassName} data-streamdown="mermaid-block">
				<div className="flex items-center justify-between px-1 text-xs">
					<span className="font-mono text-muted-foreground">Mermaid</span>
					<span className="text-muted-foreground">Rendering…</span>
				</div>
				<pre className="max-h-56 overflow-auto rounded-lg bg-background/70 p-3 text-xs">
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	return (
		<div className={surfaceClassName} data-streamdown="mermaid-block">
			<div className="flex items-center justify-between px-1 text-xs">
				<span className="font-mono text-muted-foreground">Mermaid</span>
				<div className="flex items-center gap-1 opacity-70 transition-opacity group-focus-within/mermaid-block:opacity-100 group-hover/mermaid-block:opacity-100">
					<CopyFormatMenu
						ariaLabel="Copy diagram"
						dataTestId="mermaid-copy"
						onCopy={handleCopy}
						options={DIAGRAM_COPY_OPTIONS}
					/>
					<Button
						appearance="markdown-diagram-expand"
						aria-label="Expand diagram"
						className="size-7"
						data-testid="mermaid-expand"
						onClick={() => setLightboxOpen(true)}
						size="icon"
						title="Expand diagram"
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon aria-hidden="true" icon={ExpandIcon} size={14} />
					</Button>
				</div>
			</div>
			<button
				aria-label="Open Mermaid diagram"
				className="flex max-h-[32rem] min-h-28 w-full cursor-zoom-in items-center justify-center overflow-auto rounded-lg bg-background/70 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={(event) => {
					originRef.current = event.currentTarget;
					setLightboxOpen(true);
				}}
				ref={originRef}
				type="button"
			>
				{/* Mermaid's strict renderer sanitizes the SVG before it reaches this
				    surface. The output is still inserted as markup so labels and arrows
				    remain selectable vectors rather than a screenshot. */}
				<span
					className="flex max-w-full items-center justify-center [&>svg]:h-auto [&>svg]:max-h-[28rem] [&>svg]:max-w-full"
					dangerouslySetInnerHTML={{ __html: svg }}
				/>
			</button>
			{diagramUrl ? (
				<ImageLightbox
					images={[{ filename: "diagram.svg", id, url: diagramUrl }]}
					onClose={() => setLightboxOpen(false)}
					open={lightboxOpen}
					originRef={originRef}
				/>
			) : null}
		</div>
	);
}
