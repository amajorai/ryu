"use client";

import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Stage } from "./image-lightbox-stage.tsx";
import type { ImageLightboxProps } from "./image-lightbox-types.ts";

export type {
	ImageLightboxProps,
	LightboxImage,
} from "./image-lightbox-types.ts";

export function ImageLightbox(props: ImageLightboxProps) {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (globalThis.document === undefined) {
		return null;
	}
	if (!mounted) {
		return null;
	}

	return createPortal(
		<AnimatePresence>
			{props.open ? <Stage key="lightbox" {...props} /> : null}
		</AnimatePresence>,
		document.body
	);
}
