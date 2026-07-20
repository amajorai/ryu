"use client";

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { IconChevronLeft, IconChevronRight, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface LightboxImage {
	/** Optional filename used for the alt text. */
	filename?: string;
	/** Stable identifier — used for keys and to know which image is active. */
	id: string;
	/** Resolvable image URL (https / data: / blob:). */
	url: string;
}

export interface ImageLightboxProps {
	/** Full set of images for gallery navigation. */
	images: LightboxImage[];
	/** Index in `images` to start on. */
	initialIndex?: number;
	/** Close handler — wired to overlay click, X button, and Esc key. */
	onClose: () => void;
	/** Whether the overlay is open. */
	open: boolean;
}

/**
 * Portal-based fullscreen image preview. Renders to `document.body` so it
 * escapes any clipping/transform/stacking context. Adapted from the
 * 21st-private-1 desktop chat — without copy/save (those are
 * desktop-API-specific).
 */
export function ImageLightbox({
	open,
	onClose,
	images,
	initialIndex = 0,
}: ImageLightboxProps) {
	const [currentIndex, setCurrentIndex] = useState(initialIndex);
	const hasMultipleImages = images.length > 1;

	// Sync the active index whenever the consumer re-opens with a new initial.
	useEffect(() => {
		if (open) {
			setCurrentIndex(initialIndex);
		}
	}, [open, initialIndex]);

	const goToPrevious = useCallback(
		(event?: React.MouseEvent) => {
			event?.stopPropagation();
			setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
		},
		[images.length]
	);

	const goToNext = useCallback(
		(event?: React.MouseEvent) => {
			event?.stopPropagation();
			setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
		},
		[images.length]
	);

	// Esc / arrow-key navigation. Capture phase so we beat any local handlers
	// (e.g. an Editor that swallows Esc).
	useEffect(() => {
		if (!open) {
			return;
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			switch (event.key) {
				case "Escape":
					event.preventDefault();
					event.stopPropagation();
					onClose();
					break;
				case "ArrowLeft":
					if (hasMultipleImages) {
						goToPrevious();
					}
					break;
				case "ArrowRight":
					if (hasMultipleImages) {
						goToNext();
					}
					break;
			}
		};
		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [open, hasMultipleImages, onClose, goToPrevious, goToNext]);

	// Lock body scroll while open so the page underneath doesn't move.
	useEffect(() => {
		if (!open) {
			return;
		}
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [open]);

	if (typeof document === "undefined") {
		return null;
	}
	if (!open) {
		return null;
	}
	const currentImage = images[currentIndex] ?? images[0];
	if (!currentImage?.url) {
		return null;
	}

	return createPortal(
		<div
			aria-modal="true"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
			onClick={onClose}
			role="dialog"
		>
			<Button
				aria-label="Close fullscreen (Esc)"
				className="absolute top-4 right-4 z-10 size-9 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
				onClick={onClose}
				size="icon"
				type="button"
				variant="ghost"
			>
				<IconX className="size-5" />
			</Button>

			{hasMultipleImages && (
				<Button
					aria-label="Previous image (←)"
					className="absolute top-1/2 left-4 z-10 size-10 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
					onClick={goToPrevious}
					size="icon"
					type="button"
					variant="ghost"
				>
					<IconChevronLeft className="size-6" />
				</Button>
			)}

			<img
				alt={currentImage.filename ?? "Image preview"}
				className="max-h-[85vh] max-w-[90vw] select-none object-contain"
				draggable={false}
				onClick={(event) => event.stopPropagation()}
				src={currentImage.url}
			/>

			{hasMultipleImages && (
				<Button
					aria-label="Next image (→)"
					className="absolute top-1/2 right-4 z-10 size-10 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
					onClick={goToNext}
					size="icon"
					type="button"
					variant="ghost"
				>
					<IconChevronRight className="size-6" />
				</Button>
			)}

			{hasMultipleImages && (
				<div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
					<div className="flex gap-2">
						{images.map((_, idx) => (
							<button
								aria-label={`Go to image ${idx + 1}`}
								className={cn(
									"size-2 rounded-full transition-all",
									idx === currentIndex
										? "scale-125 bg-white"
										: "bg-white/40 hover:bg-white/60"
								)}
								key={idx}
								onClick={(event) => {
									event.stopPropagation();
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
		</div>,
		document.body
	);
}
