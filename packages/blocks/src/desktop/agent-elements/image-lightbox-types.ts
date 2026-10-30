export interface LightboxImage {
	/** Optional image title used for the alt text, caption, and download filename. */
	filename?: string;
	/** Stable identifier — used for keys and to know which image is active. */
	id: string;
	/** Resolvable image URL (https / data: / blob:). */
	url: string;
}

export interface ImageLightboxProps {
	/** Appended last to the fixed overlay shell. */
	className?: string;
	/** Full set of images for gallery navigation. */
	images: LightboxImage[];
	/** Index in `images` to start on. */
	initialIndex?: number;
	/** Ceiling for wheel, double-click and keyboard zoom. Values at or below
	 *  1.1 are raised to 1.1. */
	maxScale?: number;
	/** Optional image-editing action for opening Drawesome annotation. */
	onAnnotate?: (image: LightboxImage) => void;
	/** Close handler — wired to Escape, the close button, and a backdrop click
	 *  while unzoomed. The overlay stays mounted until the return flight ends. */
	onClose: () => void;
	/** Whether the overlay is mounted. The caller owns it, so the trigger stays
	 *  the caller's element. */
	open: boolean;
	/**
	 * The thumbnail the image morphs from and returns to. Point it at the
	 * clicked thumbnail in the click handler. Omitted, the overlay falls back
	 * to a 0.97-scale enter and exit.
	 */
	originRef?: React.RefObject<HTMLElement | null>;
}
