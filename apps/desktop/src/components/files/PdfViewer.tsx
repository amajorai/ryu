import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	MinusSignIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

interface PdfViewerProps {
	bytes: ArrayBuffer;
	onLoadError: (message: string) => void;
}

export function PdfViewer({ bytes, onLoadError }: PdfViewerProps) {
	const tl = useLiteralMessages();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
	const [pageNumber, setPageNumber] = useState(1);
	const [scale, setScale] = useState(1.15);
	const [rendering, setRendering] = useState(false);

	useEffect(() => {
		let disposed = false;
		let loadingTask: PDFDocumentLoadingTask | undefined;
		import("pdfjs-dist")
			.then(async (pdfjs) => {
				if (disposed) {
					return;
				}
				pdfjs.GlobalWorkerOptions.workerSrc = new URL(
					"pdfjs-dist/build/pdf.worker.min.mjs",
					import.meta.url
				).toString();
				loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
				const loaded = await loadingTask.promise;
				if (!disposed) {
					setDocument(loaded);
					setPageNumber(1);
				}
			})
			.catch((error) => {
				if (!disposed) {
					onLoadError(
						error instanceof Error
							? error.message
							: "This PDF could not be opened."
					);
				}
			});
		return () => {
			disposed = true;
			// Destroy also cancels pending parsing and terminates the owned worker.
			loadingTask?.destroy().catch(() => undefined);
		};
	}, [bytes, onLoadError]);

	useEffect(() => {
		if (!(document && canvasRef.current)) {
			return;
		}
		let cancelled = false;
		let cancelRender: (() => void) | undefined;
		setRendering(true);
		document
			.getPage(pageNumber)
			.then((page) => {
				if (cancelled || !canvasRef.current) {
					return;
				}
				const canvas = canvasRef.current;
				const viewport = page.getViewport({ scale });
				const ratio = window.devicePixelRatio || 1;
				canvas.width = Math.floor(viewport.width * ratio);
				canvas.height = Math.floor(viewport.height * ratio);
				canvas.style.width = `${Math.floor(viewport.width)}px`;
				canvas.style.height = `${Math.floor(viewport.height)}px`;
				const context = canvas.getContext("2d");
				if (!context) {
					throw new Error("Canvas rendering is unavailable.");
				}
				const task = page.render({
					canvas,
					canvasContext: context,
					transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
					viewport,
				});
				cancelRender = () => task.cancel();
				return task.promise;
			})
			.then(() => {
				if (!cancelled) {
					setRendering(false);
				}
			})
			.catch((error) => {
				if (
					!(
						cancelled ||
						(error instanceof Error &&
							error.name === "RenderingCancelledException")
					)
				) {
					onLoadError(
						error instanceof Error
							? error.message
							: "This PDF page could not be rendered."
					);
				}
			});
		return () => {
			cancelled = true;
			cancelRender?.();
		};
	}, [document, onLoadError, pageNumber, scale]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-muted/30">
			<div className="flex h-10 shrink-0 items-center justify-center gap-1 border-border border-b bg-background px-3">
				<Button
					aria-label="Previous page"
					disabled={pageNumber <= 1}
					onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</Button>
				<Input
					aria-label="Page number"
					className="h-8 w-14 text-center"
					max={document?.numPages ?? 1}
					min={1}
					onChange={(event) => {
						const next = Number(event.currentTarget.value);
						if (Number.isFinite(next)) {
							setPageNumber(
								Math.max(1, Math.min(document?.numPages ?? 1, Math.trunc(next)))
							);
						}
					}}
					type="number"
					value={pageNumber}
				/>
				<span className="mr-3 text-muted-foreground text-sm">
					/ {document?.numPages ?? "—"}
				</span>
				<Button
					aria-label="Next page"
					disabled={!document || pageNumber >= document.numPages}
					onClick={() =>
						setPageNumber((value) =>
							Math.min(document?.numPages ?? value, value + 1)
						)
					}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				</Button>
				<div className="mx-2 h-5 w-px bg-border" />
				<Button
					aria-label="Zoom out"
					disabled={scale <= 0.5}
					onClick={() => setScale((value) => Math.max(0.5, value - 0.15))}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={MinusSignIcon} />
				</Button>
				<span className="w-12 text-center text-muted-foreground text-xs">
					{Math.round(scale * 100)}%
				</span>
				<Button
					aria-label="Zoom in"
					disabled={scale >= 3}
					onClick={() => setScale((value) => Math.min(3, value + 0.15))}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-6">
				<div className="mx-auto w-fit bg-white shadow-xl">
					<canvas
						aria-label={tl("PDF page {pageNumber}", {
							pageNumber: String(pageNumber),
						})}
						className={rendering ? "opacity-60" : undefined}
						ref={canvasRef}
					/>
				</div>
			</div>
		</div>
	);
}
