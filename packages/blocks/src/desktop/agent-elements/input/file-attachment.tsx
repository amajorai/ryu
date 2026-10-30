import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useRef, useState } from "react";
import { FileTypeIcon } from "../file-type-icon.tsx";
import { ImageLightbox, type LightboxImage } from "../image-lightbox.tsx";

export interface FileAttachmentProps {
	className?: string;
	display?: "chip" | "image-only";
	/**
	 * When true (default) clicking the image thumbnail opens a fullscreen
	 * preview. Set to false to render a non-interactive thumbnail.
	 */
	enableImagePreview?: boolean;
	filename: string;
	id: string;
	isImage?: boolean;
	onAnnotate?: (image: LightboxImage) => void;
	onRemove?: () => void;
	size?: number;
	url?: string;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Thumbnail wrapper: a real button when the image can be previewed so the
 * lightbox opens from the keyboard too, a plain box otherwise.
 */
function PreviewTrigger({
	canPreview,
	children,
	className,
	filename,
	onOpen,
}: {
	canPreview: boolean;
	children: React.ReactNode;
	className: string;
	filename: string;
	onOpen: (event: React.MouseEvent<HTMLElement>) => void;
}) {
	const tl = useLiteralMessages();
	if (!canPreview) {
		return <div className={className}>{children}</div>;
	}
	return (
		<button
			aria-label={tl("Preview {filename}", { filename })}
			className={cn(
				className,
				"cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
			)}
			onClick={onOpen}
			type="button"
		>
			{children}
		</button>
	);
}

export function FileAttachment({
	id,
	filename,
	size,
	isImage,
	url,
	onRemove,
	onAnnotate,
	className,
	display = "chip",
	enableImagePreview = true,
}: FileAttachmentProps) {
	const safeUrl = safeMediaUrl(url);
	const tl = useLiteralMessages();
	const [isHovered, setIsHovered] = useState(false);
	const [isLightboxOpen, setIsLightboxOpen] = useState(false);
	const lightboxOriginRef = useRef<HTMLElement | null>(null);
	const isImageOnly = display === "image-only" && isImage && !!safeUrl;
	const canPreview = Boolean(enableImagePreview && isImage && safeUrl);

	const openLightbox = (event: React.MouseEvent<HTMLElement>) => {
		event.stopPropagation();
		lightboxOriginRef.current = event.currentTarget;
		setIsLightboxOpen(true);
	};

	return (
		<div
			className={cn(
				"relative rounded-lg bg-muted",
				isImageOnly
					? "flex size-24 shrink-0 items-center justify-center rounded-xl p-1"
					: "flex min-w-[120px] max-w-[200px] items-center gap-2 py-1 pr-2 pl-1",
				className
			)}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{isImageOnly ? (
				<PreviewTrigger
					canPreview={canPreview}
					className="size-full shrink-0 overflow-hidden rounded-lg"
					filename={filename}
					onOpen={openLightbox}
				>
					<img
						alt={filename}
						className="h-full w-full object-cover"
						src={safeUrl ?? undefined}
					/>
				</PreviewTrigger>
			) : (
				<>
					{isImage && safeUrl ? (
						<PreviewTrigger
							canPreview={canPreview}
							className="w-8 shrink-0 self-stretch overflow-hidden rounded-lg"
							filename={filename}
							onOpen={openLightbox}
						>
							<img
								alt={filename}
								className="aspect-square h-full w-full object-cover"
								src={safeUrl}
							/>
						</PreviewTrigger>
					) : (
						<div className="flex w-8 shrink-0 items-center justify-center self-stretch rounded-lg bg-background">
							<FileTypeIcon className="size-4" path={filename} />
						</div>
					)}

					<div className="flex min-w-0 flex-col">
						<span
							className="truncate font-medium text-foreground text-sm"
							title={filename}
						>
							{filename}
						</span>
						{size !== undefined && (
							<span className="text-muted-foreground text-xs">
								{formatFileSize(size)}
							</span>
						)}
					</div>
				</>
			)}

			{onRemove && (
				<Button
					appearance={
						isHovered ? "attachment-remove-visible" : "attachment-remove-hidden"
					}
					aria-label={tl("Remove {filename}", { filename })}
					className="absolute -top-1.5 -right-1.5 z-10 focus-visible:opacity-100"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					size="icon"
					type="button"
					variant="outline"
				>
					<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
				</Button>
			)}

			{canPreview && safeUrl && (
				<ImageLightbox
					images={[{ id, url: safeUrl, filename }]}
					onAnnotate={onAnnotate}
					onClose={() => setIsLightboxOpen(false)}
					open={isLightboxOpen}
					originRef={lightboxOriginRef}
				/>
			)}
		</div>
	);
}
