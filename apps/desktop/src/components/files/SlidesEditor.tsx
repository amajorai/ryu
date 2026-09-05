import {
	getShapeId,
	getShapeName,
	getShapeText,
	getSlidePartName,
	getSlideShapes,
	getSlides,
	hasShapeText,
	loadPresentation,
	type PresentationData,
	type SlideShapeData,
	savePresentation,
	setShapeText,
} from "@office-kit/pptx";
import { renderSlideToSvg } from "@office-kit/pptx-preview";
import { Textarea } from "@ryu/ui/components/textarea";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useState,
} from "react";
import type { FileEditorHandle } from "./DocxEditor.tsx";

interface SlidesEditorProps {
	bytes: ArrayBuffer;
	mime: string;
	onDirty: () => void;
	onLoadError: (message: string) => void;
}

function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const SlidesEditor = forwardRef<FileEditorHandle, SlidesEditorProps>(
	function SlidesEditor({ bytes, mime, onDirty, onLoadError }, ref) {
		const [presentation, setPresentation] = useState<PresentationData | null>(
			null
		);
		const [activeSlide, setActiveSlide] = useState(0);
		const [revision, setRevision] = useState(0);

		useEffect(() => {
			let cancelled = false;
			loadPresentation(bytes)
				.then((loaded) => {
					if (cancelled) {
						return;
					}
					if (getSlides(loaded).length === 0) {
						throw new Error("This slide deck does not contain any slides.");
					}
					setPresentation(loaded);
				})
				.catch((error: unknown) => {
					if (!cancelled) {
						onLoadError(
							error instanceof Error
								? error.message
								: "This slide deck could not be opened."
						);
					}
				});
			return () => {
				cancelled = true;
			};
		}, [bytes, onLoadError]);

		useImperativeHandle(
			ref,
			() => ({
				exportFile: async () => {
					if (!presentation) {
						throw new Error("The slide deck is still loading.");
					}
					const output = await savePresentation(presentation);
					return new Blob([Uint8Array.from(output)], { type: mime });
				},
			}),
			[mime, presentation]
		);

		const slides = presentation ? getSlides(presentation) : [];
		const slide = slides[activeSlide];
		const previewUrls = useMemo(
			() =>
				presentation
					? getSlides(presentation).map((item) =>
							svgDataUrl(renderSlideToSvg(presentation, item))
						)
					: [],
			[presentation, revision]
		);
		const textShapes = useMemo(
			() =>
				slide
					? getSlideShapes(slide).filter((shape): shape is SlideShapeData =>
							hasShapeText(shape)
						)
					: [],
			[slide, revision]
		);

		if (!(presentation && slide)) {
			return (
				<div className="grid min-h-0 flex-1 place-items-center text-muted-foreground text-sm">
					Opening slide deck…
				</div>
			);
		}

		return (
			<div className="grid min-h-0 flex-1 grid-cols-[148px_minmax(0,1fr)_280px] bg-muted/20">
				<nav
					aria-label="Slides"
					className="min-h-0 overflow-y-auto border-border border-r bg-background p-2"
				>
					{slides.map((item, index) => (
						<button
							aria-label={`Open slide ${index + 1}`}
							className={`mb-2 w-full rounded-md border p-1 text-left transition-colors ${
								index === activeSlide
									? "border-primary bg-primary/5"
									: "border-border bg-background hover:bg-muted"
							}`}
							key={getSlidePartName(item)}
							onClick={() => setActiveSlide(index)}
							type="button"
						>
							<img
								alt=""
								className="aspect-video w-full bg-white object-contain"
								height={72}
								src={previewUrls[index]}
								width={128}
							/>
							<span className="mt-1 block px-1 text-muted-foreground text-xs">
								{index + 1}
							</span>
						</button>
					))}
				</nav>
				<main className="grid min-h-0 place-items-center overflow-auto p-6">
					<img
						alt={`Slide ${activeSlide + 1} preview`}
						className="aspect-video w-full max-w-5xl border border-border bg-white object-contain shadow-xl"
						height={720}
						src={previewUrls[activeSlide]}
						width={1280}
					/>
				</main>
				<aside className="min-h-0 overflow-y-auto border-border border-l bg-background p-3">
					<h2 className="mb-1 font-medium text-sm">Slide text</h2>
					<p className="mb-4 text-muted-foreground text-xs">
						Edit text boxes while the slide preview updates.
					</p>
					{textShapes.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							This slide has no editable text boxes.
						</p>
					) : (
						<div className="space-y-3">
							{textShapes.map((shape, index) => (
								<label className="block" key={getShapeId(shape)}>
									<span className="mb-1 block font-medium text-xs">
										{getShapeName(shape) || `Text box ${index + 1}`}
									</span>
									<Textarea
										defaultValue={getShapeText(shape)}
										key={`${activeSlide}:${index}:${revision}`}
										onBlur={(event) => {
											setShapeText(shape, event.currentTarget.value);
											setRevision((value) => value + 1);
											onDirty();
										}}
										rows={4}
									/>
								</label>
							))}
						</div>
					)}
				</aside>
			</div>
		);
	}
);
