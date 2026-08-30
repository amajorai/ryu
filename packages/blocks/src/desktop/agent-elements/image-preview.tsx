import { cn } from "@ryu/ui/lib/utils";
import type { ImgHTMLAttributes } from "react";
import { useRef, useState } from "react";
import { ImageLightbox } from "./image-lightbox.tsx";

export function InlineImagePreview({
	alt,
	className,
	filename,
	imageClassName,
	src,
	...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	filename?: string;
	imageClassName?: string;
	src: string;
}) {
	const [open, setOpen] = useState(false);
	const originRef = useRef<HTMLButtonElement | null>(null);
	const label = filename ?? alt ?? "Image";

	return (
		<>
			<button
				aria-label={`Open ${label}`}
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
						"block h-auto w-auto max-w-full object-contain transition-[filter] duration-150 group-hover/chat-image:brightness-95",
						imageClassName
					)}
					src={src}
					{...props}
				/>
			</button>
			<ImageLightbox
				images={[{ filename: label, id: `inline-image-${label}`, url: src }]}
				onClose={() => setOpen(false)}
				open={open}
				originRef={originRef}
			/>
		</>
	);
}
