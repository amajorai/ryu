"use client";

import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Cancel01Icon,
	Download01Icon,
	MinusSignIcon,
	PencilEdit02Icon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { imageViewerControlClasses } from "@ryu/ui/components/button-variants.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	animate,
	buildTransform,
	motion,
	type TargetAndTransition,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from "motion/react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import {
	CONTROL_ZOOM_STEP,
	EASE,
	EXIT,
	HOME,
	type ImageViewerContentStyle,
	type ImageViewerFlightStyle,
	VEIL,
} from "./image-lightbox-motion.ts";
import {
	useStageBodyLock,
	useStageKeyboard,
} from "./image-lightbox-stage-effects.ts";
import type { ImageLightboxProps } from "./image-lightbox-types.ts";
import { useLightbox } from "./image-lightbox-use-lightbox.ts";

interface Landing {
	dx: number;
	dy: number;
	o: number;
	r: number;
	s: number;
}

export function Stage({
	onClose,
	onAnnotate,
	images,
	initialIndex,
	originRef,
	maxScale = 4,
	className = "",
}: ImageLightboxProps) {
	const tl = useLiteralMessages();
	const reduced = useReducedMotion();
	const titleId = useId();
	const hintId = useId();

	const [currentIndex, setCurrentIndex] = useState(initialIndex ?? 0);
	const [loaded, setLoaded] = useState(false);
	const [size, setSize] = useState<{ w: number; h: number } | null>(null);
	const landedRef = useRef(false);
	const releaseBodyLockRef = useRef<(() => void) | null>(null);

	const currentImage = images[currentIndex] ?? images[0];
	const hasMultipleImages = images.length > 1;

	const fx = useMotionValue(0);
	const fy = useMotionValue(0);
	const fs = useMotionValue(1);
	const fo = useMotionValue(0);
	const fr = useMotionValue(14);

	const {
		frameRef,
		contentRef,
		bind,
		scale,
		x,
		y,
		zoom,
		zoomed,
		settledZoom,
		reset,
		zoomAt,
	} = useLightbox({ maxScale, onDismiss: onClose });

	// Keep Motion's native transform formatting and the same numeric spring values.
	const flightTransform = useTransform(() =>
		buildTransform({ x: fx.get(), y: fy.get(), scale: fs.get() }, {})
	);
	const contentTransform = useTransform(() =>
		buildTransform({ x: x.get(), y: y.get(), scale: scale.get() }, {})
	);

	const flightStyle: ImageViewerFlightStyle = {
		"--image-viewer-flight-x": fx,
		"--image-viewer-flight-y": fy,
		"--image-viewer-flight-scale": fs,
		"--image-viewer-flight-transform": flightTransform,
		"--image-viewer-flight-opacity": fo,
	};
	const contentStyle: ImageViewerContentStyle = {
		"--image-viewer-content-x": x,
		"--image-viewer-content-y": y,
		"--image-viewer-content-scale": scale,
		"--image-viewer-content-transform": contentTransform,
		"--image-viewer-content-radius": fr,
	};

	const shellRef = useRef<HTMLDivElement>(null);
	const zoomCeiling = Math.max(1.1, maxScale);

	const adjustZoom = useCallback(
		(delta: number) => {
			const frame = frameRef.current;
			if (!frame) {
				return;
			}
			const r = frame.getBoundingClientRect();
			zoomAt(
				scale.get() + delta,
				r.left + r.width / 2,
				r.top + r.height / 2,
				true
			);
		},
		[frameRef, scale, zoomAt]
	);

	const goToPrevious = useCallback(() => {
		reset();
		setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
	}, [images.length, reset]);

	const goToNext = useCallback(() => {
		reset();
		setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
	}, [images.length, reset]);

	const landing = useCallback((): Landing => {
		const frame = frameRef.current;
		const content = contentRef.current;
		const origin = originRef?.current;
		if (frame && content && origin && content.offsetWidth > 0) {
			const r = frame.getBoundingClientRect();
			const o = origin.getBoundingClientRect();
			if (o.width > 0) {
				const s = o.width / content.offsetWidth;
				const rad =
					Number.parseFloat(getComputedStyle(origin).borderTopLeftRadius) || 9;
				return {
					dx: o.left + o.width / 2 - (r.left + r.width / 2),
					dy: o.top + o.height / 2 - (r.top + r.height / 2),
					s,
					o: 1,
					r: rad / s,
				};
			}
		}
		return { dx: 0, dy: 10, s: 0.97, o: 0, r: 14 };
	}, [contentRef, frameRef, originRef]);

	useLayoutEffect(() => {
		if (reduced) {
			fx.set(0);
			fy.set(0);
			fs.set(1);
			fo.set(1);
			fr.set(14);
			landedRef.current = true;
			return;
		}
		if (!loaded || landedRef.current) {
			return;
		}
		landedRef.current = true;
		const d = landing();
		fx.set(d.dx);
		fy.set(d.dy);
		fs.set(d.s);
		fo.set(d.o);
		fr.set(d.r);

		const runs = [
			animate(fx, 0, HOME),
			animate(fy, 0, HOME),
			animate(fs, 1, HOME),
			animate(fo, 1, HOME),
			animate(fr, 14, HOME),
		];
		return () => runs.forEach((r) => r.stop());
	}, [fo, fr, fs, fx, fy, landing, loaded, reduced]);

	const away = useCallback((): TargetAndTransition => {
		if (reduced) {
			return {
				"--image-viewer-flight-opacity": 0,
				transition: { duration: 0.12 },
			};
		}
		const d = landing();
		animate(fr, d.r, HOME);
		return {
			"--image-viewer-flight-x": d.dx,
			"--image-viewer-flight-y": d.dy,
			"--image-viewer-flight-scale": d.s,
			"--image-viewer-flight-opacity": d.o,
			filter: "blur(4px)",
			transition: HOME,
		};
	}, [fr, landing, reduced]);

	const unwind = useCallback(
		() => ({
			"--image-viewer-content-x": 0,
			"--image-viewer-content-y": 0,
			"--image-viewer-content-scale": 1,
			transition: reduced ? { duration: 0 } : HOME,
		}),
		[reduced]
	);

	useStageBodyLock(frameRef, releaseBodyLockRef);

	useStageKeyboard({
		shellRef,
		zoomed,
		hasMultipleImages,
		goToPrevious,
		goToNext,
		onClose,
	});

	const safeCurrentUrl = currentImage ? safeMediaUrl(currentImage.url) : null;
	if (!(currentImage && safeCurrentUrl)) {
		return null;
	}

	const filename = currentImage.filename?.trim() || "Image preview";

	return (
		<div
			aria-labelledby={titleId}
			aria-modal="true"
			className={`fixed inset-0 z-50 ${className}`}
			ref={shellRef}
			role="dialog"
		>
			<motion.div
				animate={{ opacity: 1 }}
				aria-hidden
				className="absolute inset-0 bg-black/90 backdrop-blur-sm"
				exit={{
					opacity: 0,
					transition: reduced ? { duration: 0 } : { duration: 0.3, ease: EASE },
				}}
				initial={{ opacity: 0 }}
				transition={reduced ? { duration: 0 } : VEIL}
			/>
			<div
				aria-describedby={hintId}
				aria-labelledby={titleId}
				className={`image-viewer-no-callout focus-visible:image-viewer-focus-ring absolute inset-0 touch-none select-none overflow-hidden outline-none ${
					zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
				}`}
				data-lightbox-focus="1"
				ref={frameRef}
				role="group"
				tabIndex={-1}
				{...bind}
			>
				<motion.div
					animate={{ filter: "blur(0px)" }}
					className="image-viewer-flight absolute inset-0 flex items-center justify-center p-4 pb-32 sm:p-14 sm:pb-32"
					exit="away"
					initial={reduced ? false : { filter: "blur(6px)" }}
					style={flightStyle}
					transition={
						reduced
							? { duration: 0 }
							: { filter: { duration: 0.35, ease: EASE } }
					}
					variants={{ away }}
				>
					<motion.img
						alt={filename}
						className="image-viewer-content max-h-full max-w-full object-contain"
						draggable={false}
						exit="away"
						height={size?.h}
						onError={() => setLoaded(true)}
						onLoad={(e) => {
							setSize({
								w: e.currentTarget.naturalWidth,
								h: e.currentTarget.naturalHeight,
							});
							setLoaded(true);
						}}
						ref={contentRef}
						src={safeCurrentUrl}
						style={contentStyle}
						variants={{ away: unwind }}
						width={size?.w}
					/>
				</motion.div>
			</div>
			<motion.div
				animate={{ opacity: 1 }}
				className="pointer-events-none absolute inset-0 flex items-start justify-end gap-3 p-3 sm:p-4"
				exit={{ opacity: 0, transition: reduced ? { duration: 0 } : EXIT }}
				initial={{ opacity: 0 }}
				transition={reduced ? { duration: 0 } : VEIL}
			>
				<div className="pointer-events-auto flex items-center gap-2">
					{onAnnotate ? (
						<Button
							appearance="image-viewer"
							aria-label={tl("Annotate {filename}", { filename })}
							data-lightbox-focus="1"
							onClick={() => {
								// Release before the editor acquires its own modal lock. The
								// exit animation must not restore styles over that new owner.
								releaseBodyLockRef.current?.();
								onAnnotate(currentImage);
								onClose();
							}}
							size="icon"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={PencilEdit02Icon} />
						</Button>
					) : null}
					<a
						aria-label={tl("Download {filename}", { filename })}
						className={imageViewerControlClasses}
						data-lightbox-focus="1"
						download={filename}
						href={safeCurrentUrl}
						rel="noopener noreferrer"
					>
						<HugeiconsIcon className="size-4" icon={Download01Icon} />
					</a>
					<Button
						appearance="image-viewer"
						aria-label="Close"
						data-lightbox-focus="1"
						onClick={onClose}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					</Button>
				</div>
			</motion.div>
			<div className="pointer-events-none absolute inset-x-0 bottom-5 flex flex-col items-center gap-2 px-3 sm:bottom-6">
				{hasMultipleImages && (
					<div className="pointer-events-auto flex items-center gap-3">
						<div className="flex items-center gap-2">
							{images.map((_, idx) => (
								<button
									aria-current={idx === currentIndex ? "true" : undefined}
									aria-label={tl("Go to image {index}", {
										index: String(idx + 1),
									})}
									className={cn(
										"relative size-2 rounded-full outline-none transition-[scale,background-color] after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none",
										idx === currentIndex
											? "scale-125 bg-white"
											: "bg-white/40 hover:bg-white/60"
									)}
									data-lightbox-focus="1"
									key={idx}
									onClick={() => {
										reset();
										setCurrentIndex(idx);
									}}
									type="button"
								/>
							))}
						</div>
						<span className="text-sm text-white/70">
							{currentIndex + 1} / {images.length}
						</span>
					</div>
				)}
				<p
					className="pointer-events-auto max-w-[80vw] truncate rounded-full border border-white/10 bg-black/50 px-3 py-1.5 text-white/90 text-xs backdrop-blur-sm sm:max-w-[32rem]"
					id={titleId}
					title={filename}
				>
					{filename}
				</p>
				<div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/50 p-1 backdrop-blur-sm">
					<Button
						appearance="image-viewer"
						aria-label="Zoom out"
						data-lightbox-focus="1"
						disabled={zoom <= 1.01}
						onClick={() => adjustZoom(-CONTROL_ZOOM_STEP)}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={MinusSignIcon} />
					</Button>
					<span
						aria-live="polite"
						className="min-w-12 text-center font-medium text-sm text-white tabular-nums"
					>
						{Math.round(zoom * 100)}%
					</span>
					<Button
						appearance="image-viewer"
						aria-label="Zoom in"
						data-lightbox-focus="1"
						disabled={zoom >= zoomCeiling - 0.01}
						onClick={() => adjustZoom(CONTROL_ZOOM_STEP)}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={PlusSignIcon} />
					</Button>
				</div>
			</div>

			{hasMultipleImages && (
				<>
					<Button
						appearance="image-viewer"
						aria-label="Previous image (←)"
						className="pointer-events-auto absolute top-1/2 left-3 z-10 -translate-y-1/2 sm:left-4"
						data-lightbox-focus="1"
						onClick={goToPrevious}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-5" icon={ArrowLeft01Icon} />
					</Button>
					<Button
						appearance="image-viewer"
						aria-label="Next image (→)"
						className="pointer-events-auto absolute top-1/2 right-3 z-10 -translate-y-1/2 sm:right-4"
						data-lightbox-focus="1"
						onClick={goToNext}
						size="icon"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-5" icon={ArrowRight01Icon} />
					</Button>
				</>
			)}
			<p className="sr-only" id={hintId}>
				Scroll to zoom toward the pointer, or press plus and minus. Drag or use
				the arrow keys to pan, and double-click to switch between fit and
				close-up. Press zero to return to the starting frame; Escape returns
				home first, then closes.
			</p>
			<p className="sr-only" role="status">
				{tl("Zoom {zoom} times", { zoom: settledZoom.toFixed(1) })}
			</p>
		</div>
	);
}
