import { useLiteralMessages } from "@ryu/i18n/react";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { ImgHTMLAttributes } from "react";
import { useRef, useState } from "react";
import styles from "./elements-one.module.css";
import type { LightboxImage } from "./image-lightbox.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";

export function InlineImagePreview({
	alt,
	className,
	filename,
	imageClassName,
	onAnnotate,
	src,
	...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	filename?: string;
	imageClassName?: string;
	onAnnotate?: (image: LightboxImage) => void;
	src: string;
}) {
	const safeSrc = safeMediaUrl(src);
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const originRef = useRef<HTMLButtonElement | null>(null);
	const label = filename ?? alt ?? tl("Image");

	return (
		<>
			<button
				aria-label={tl("Open {label}", { label })}
				className={cn(
					"group/chat-image relative flex w-full max-w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
					className
				)}
				onClick={() => setOpen(true)}
				ref={originRef}
				type="button"
			>
				<img
					alt={alt ?? label}
					className={cn(
						styles.filterTransition,
						"block h-auto w-auto max-w-full object-contain duration-150 group-hover/chat-image:brightness-95",
						imageClassName
					)}
					src={safeSrc ?? undefined}
					{...props}
				/>
			</button>
			{safeSrc ? (
				<ImageLightbox
					images={[
						{ filename: label, id: `inline-image-${label}`, url: safeSrc },
					]}
					onAnnotate={onAnnotate}
					onClose={() => setOpen(false)}
					open={open}
					originRef={originRef}
				/>
			) : null}
		</>
	);
}
