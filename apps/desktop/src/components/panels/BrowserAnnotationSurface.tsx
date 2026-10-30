import { Mic01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
	type AnnotationRectStyle,
	type BrowserAnnotationKind,
	type BrowserAnnotationSurfaceProps,
	type BrowserContextResult,
	type BrowserRect,
	type BrowserStyleAdjust,
	clamp,
	createRecognition,
	describeTarget,
	extractTranscript,
	MIN_AREA_SIZE,
	rectFromPoints,
	type SpeechRecognitionLike,
	unionRects,
} from "./browser-annotation/annotation-model.ts";
import { AnnotationNotesList } from "./browser-annotation/annotation-notes-list.tsx";
import { AnnotationToolbar } from "./browser-annotation/annotation-toolbar.tsx";
import annotationStyles from "./browser-annotation.module.css";

export type {
	BrowserAnnotation,
	BrowserAnnotationInput,
	BrowserAnnotationKind,
	BrowserAnnotationSpeechRecognition,
	BrowserContextResult,
	BrowserElementContext,
	BrowserRect,
	BrowserStyleAdjust,
	BrowserWebMCPTool,
} from "./browser-annotation/annotation-model.ts";

export function BrowserAnnotationSurface({
	askRyuPending = false,
	context,
	imageUrl,
	isAnnotating,
	onAnnotate,
	onAskRyu,
	onClearAnnotations,
	onContext,
	onDeleteAnnotation,
	onToggleAnnotating,
}: BrowserAnnotationSurfaceProps) {
	const tl = useLiteralMessages();
	const frameRef = useRef<HTMLDivElement>(null);
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
	const [draftComment, setDraftComment] = useState("");
	const [draftContext, setDraftContext] = useState<BrowserContextResult | null>(
		null
	);
	const [draftSelections, setDraftSelections] = useState<BrowserRect[]>([]);
	const [draftStyle, setDraftStyle] = useState<BrowserStyleAdjust>({});
	const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
		null
	);
	const [dragCurrent, setDragCurrent] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const [adjustOpen, setAdjustOpen] = useState(false);
	const [isListening, setIsListening] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const viewport = context?.viewport ?? {
		height: 1,
		scroll_x: 0,
		scroll_y: 0,
		width: 1,
	};
	const annotations = context?.annotations ?? [];
	const safeImageUrl = safeMediaUrl(imageUrl);
	const draftRect =
		dragStart && dragCurrent ? rectFromPoints(dragStart, dragCurrent) : null;
	const selectedRect =
		draftContext?.selection?.rect ??
		(draftRect &&
		draftRect.width >= MIN_AREA_SIZE &&
		draftRect.height >= MIN_AREA_SIZE
			? draftRect
			: unionRects(draftSelections));
	const selectedTargets = draftContext?.selection?.targets ?? [];
	const draftKind: BrowserAnnotationKind =
		draftSelections.length > 1
			? "elements"
			: (draftSelections[0]?.width ?? 0) >= MIN_AREA_SIZE &&
					(draftSelections[0]?.height ?? 0) >= MIN_AREA_SIZE
				? "area"
				: "element";

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				event.key.toLowerCase() === "d"
			) {
				event.preventDefault();
				onToggleAnnotating();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onToggleAnnotating]);

	useEffect(() => {
		return () => recognitionRef.current?.stop();
	}, []);

	const toViewportPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
		const frame = frameRef.current?.getBoundingClientRect();
		if (!frame) {
			return null;
		}
		return {
			x: clamp(
				((event.clientX - frame.left) / frame.width) * viewport.width,
				0,
				viewport.width
			),
			y: clamp(
				((event.clientY - frame.top) / frame.height) * viewport.height,
				0,
				viewport.height
			),
		};
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!(isAnnotating && context)) {
			return;
		}
		const point = toViewportPoint(event);
		if (!point) {
			return;
		}
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragStart(point);
		setDragCurrent(point);
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragStart) {
			return;
		}
		const point = toViewportPoint(event);
		if (point) {
			setDragCurrent(point);
		}
	};

	const handlePointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!(dragStart && context)) {
			return;
		}
		const point = toViewportPoint(event) ?? dragCurrent ?? dragStart;
		const nextRect = rectFromPoints(dragStart, point);
		const isPoint =
			nextRect.width < MIN_AREA_SIZE || nextRect.height < MIN_AREA_SIZE;
		const nextSelections = event.shiftKey
			? [
					...draftSelections,
					isPoint ? { ...nextRect, height: 0, width: 0 } : nextRect,
				]
			: [isPoint ? { ...nextRect, height: 0, width: 0 } : nextRect];
		setDragStart(null);
		setDragCurrent(null);
		setDraftSelections(nextSelections);
		const nextContext = await onContext(nextSelections);
		setDraftContext(nextContext);
	};

	const toggleVoice = () => {
		if (isListening) {
			recognitionRef.current?.stop();
			setIsListening(false);
			return;
		}
		const recognition = createRecognition();
		if (!recognition) {
			return;
		}
		recognition.continuous = true;
		recognition.interimResults = false;
		recognition.lang = "en-US";
		recognition.onresult = (event) => {
			const transcript = extractTranscript(event);
			if (transcript) {
				setDraftComment(
					(current) => `${current}${current ? " " : ""}${transcript}`
				);
			}
		};
		recognition.onerror = () => setIsListening(false);
		recognition.onend = () => setIsListening(false);
		recognitionRef.current = recognition;
		setIsListening(true);
		recognition.start();
	};

	const saveAnnotation = async () => {
		const comment = draftComment.trim();
		if (!(comment && selectedRect)) {
			return;
		}
		setIsSaving(true);
		const style = Object.fromEntries(
			Object.entries(draftStyle).filter(([, value]) => Boolean(value))
		) satisfies BrowserStyleAdjust;
		try {
			const result = await onAnnotate({
				comment,
				kind: draftKind,
				rect: selectedRect,
				selections: draftSelections,
				style: Object.keys(style).length > 0 ? style : undefined,
			});
			if (result) {
				setDraftComment("");
				setDraftContext(null);
				setDraftSelections([]);
				setDraftStyle({});
			}
		} finally {
			setIsSaving(false);
		}
	};

	const updateStyle = (key: keyof BrowserStyleAdjust, value: string) => {
		setDraftStyle((current) => ({ ...current, [key]: value }));
	};

	const draftGeometry: AnnotationRectStyle | undefined = draftRect
		? {
				"--annotation-height": `${(draftRect.height / viewport.height) * 100}%`,
				"--annotation-left": `${(draftRect.x / viewport.width) * 100}%`,
				"--annotation-top": `${(draftRect.y / viewport.height) * 100}%`,
				"--annotation-width": `${(draftRect.width / viewport.width) * 100}%`,
			}
		: undefined;

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/20"
			data-testid="browser-annotation-surface"
		>
			<AnnotationToolbar
				annotationCount={annotations.length}
				askRyuPending={askRyuPending}
				isAnnotating={isAnnotating}
				onAskRyu={onAskRyu}
				onClearAnnotations={onClearAnnotations}
				onToggleAnnotating={onToggleAnnotating}
			/>

			<div className="min-h-0 flex-1 overflow-auto p-3">
				{safeImageUrl ? (
					<div className="flex min-h-full min-w-full items-center justify-center">
						<div
							className={cn(
								"relative inline-block max-h-full max-w-full overflow-hidden rounded-lg border border-border bg-white",
								isAnnotating && "cursor-crosshair"
							)}
							data-testid="browser-annotation-frame"
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={(event) =>
								handlePointerUp(event).catch(() => undefined)
							}
							ref={frameRef}
						>
							{/* browser screenshots are data URIs captured from the local sidecar. */}
							<img
								alt={context?.page.title || "Embedded browser tab"}
								className="block max-h-[calc(100vh-13rem)] max-w-full select-none object-contain"
								draggable={false}
								src={safeImageUrl}
							/>
							<div className="pointer-events-none absolute inset-0">
								{annotations.map((annotation, index) => {
									const geometry: AnnotationRectStyle = {
										"--annotation-height": `${(annotation.rect.height / viewport.height) * 100}%`,
										"--annotation-left": `${(annotation.rect.x / viewport.width) * 100}%`,
										"--annotation-top": `${(annotation.rect.y / viewport.height) * 100}%`,
										"--annotation-width": `${(annotation.rect.width / viewport.width) * 100}%`,
									};
									return (
										<div
											className={cn(
												annotationStyles.rect,
												"absolute rounded border-2 border-highlight/90 bg-highlight/10"
											)}
											data-testid={`browser-annotation-marker-${index + 1}`}
											key={annotation.id}
											style={geometry}
										>
											<span className="absolute -top-5 left-0 rounded bg-highlight px-1.5 py-0.5 font-medium text-black text-xs shadow-sm">
												{index + 1}
											</span>
										</div>
									);
								})}
								{draftSelections.map((selection, index) => {
									const geometry: AnnotationRectStyle = {
										"--annotation-height": `${(selection.height / viewport.height) * 100}%`,
										"--annotation-left": `${(selection.x / viewport.width) * 100}%`,
										"--annotation-top": `${(selection.y / viewport.height) * 100}%`,
										"--annotation-width": `${(selection.width / viewport.width) * 100}%`,
									};
									return (
										<div
											className={cn(
												annotationStyles.rect,
												"absolute rounded border-2 border-primary bg-primary/10"
											)}
											key={`${selection.x}:${selection.y}:${index}`}
											style={geometry}
										/>
									);
								})}
								{draftRect && (
									<div
										className={cn(
											annotationStyles.rect,
											"absolute rounded border-2 border-primary border-dashed bg-primary/10"
										)}
										style={draftGeometry}
									/>
								)}
							</div>
						</div>
					</div>
				) : (
					<div className="flex h-full min-h-48 items-center justify-center text-center text-muted-foreground text-xs">
						<div>
							<HugeiconsIcon
								className="mx-auto mb-2 size-5"
								icon={RefreshIcon}
							/>
							Select a browser tab to capture its live frame.
						</div>
					</div>
				)}
			</div>

			{isAnnotating && selectedRect && (
				<div className="shrink-0 border-border border-t bg-background p-3">
					<div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
						<span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
							{draftKind === "area"
								? "Area selected"
								: tl("{count, plural, one {# target} other {# targets}}", {
										count:
											selectedTargets.length || draftSelections.length || 1,
									})}
						</span>
						{selectedTargets.slice(0, 3).map((target) => (
							<span
								className="max-w-48 truncate"
								key={`${target.selector}:${target.rect.x}`}
								title={target.selector}
							>
								{describeTarget(target)}
							</span>
						))}
					</div>
					<div className="flex items-end gap-2">
						<textarea
							aria-label="Annotation comment"
							className="min-h-16 min-w-0 flex-1 resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
							onChange={(event) => setDraftComment(event.target.value)}
							placeholder="Describe the change you want Ryu to make…"
							value={draftComment}
						/>
						<div className="flex shrink-0 flex-col gap-1">
							<button
								aria-label={
									isListening ? "Stop voice annotation" : "Dictate annotation"
								}
								className={cn(
									"rounded-lg border p-2 text-muted-foreground hover:bg-accent hover:text-foreground",
									isListening && "border-primary/60 bg-primary/10 text-primary"
								)}
								onClick={toggleVoice}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={Mic01Icon} />
							</button>
							<button
								className="rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground text-xs disabled:cursor-not-allowed disabled:opacity-50"
								disabled={!draftComment.trim() || isSaving}
								onClick={() => saveAnnotation().catch(() => undefined)}
								type="button"
							>
								{isSaving ? "Saving…" : "Add note"}
							</button>
						</div>
					</div>
					<div className="mt-2 flex items-center justify-between">
						<button
							aria-expanded={adjustOpen}
							className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
							onClick={() => setAdjustOpen((open) => !open)}
							type="button"
						>
							{adjustOpen ? "Hide Adjust controls" : "Adjust styling"}
						</button>
						<button
							className="text-muted-foreground text-xs hover:text-foreground"
							disabled={isSaving}
							onClick={() => {
								recognitionRef.current?.stop();
								setIsListening(false);
								setDraftComment("");
								setDraftContext(null);
								setDraftSelections([]);
								setDraftStyle({});
								setAdjustOpen(false);
							}}
							type="button"
						>
							Cancel draft
						</button>
						<span className="text-muted-foreground text-xs">
							⌘⇧D toggles mode
						</span>
					</div>
					{adjustOpen && (
						<div className="mt-2 grid grid-cols-2 gap-2 border-border border-t pt-2 sm:grid-cols-4">
							{(
								[
									["font_size", "Font size"],
									["font_weight", "Weight"],
									["line_height", "Line height"],
									["letter_spacing", "Tracking"],
									["padding", "Padding"],
									["margin", "Margin"],
									["color", "Text color"],
									["background_color", "Fill color"],
								] satisfies [keyof BrowserStyleAdjust, string][]
							).map(([key, label]) => (
								<label
									className="flex flex-col gap-1 text-muted-foreground text-xs"
									key={key}
								>
									{label}
									<input
										className="rounded-lg border border-border bg-background px-1.5 py-1 text-foreground text-xs outline-none focus:border-primary/60"
										onChange={(event) => updateStyle(key, event.target.value)}
										placeholder={
											key === "color" || key === "background_color"
												? "#…"
												: "e.g. 16px"
										}
										value={draftStyle[key] ?? ""}
									/>
								</label>
							))}
						</div>
					)}
				</div>
			)}

			{annotations.length > 0 && !isAnnotating && (
				<AnnotationNotesList
					annotations={annotations}
					onDeleteAnnotation={onDeleteAnnotation}
				/>
			)}
		</div>
	);
}
