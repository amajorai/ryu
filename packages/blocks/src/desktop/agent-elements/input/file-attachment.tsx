import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconFileCode as FileCode,
	IconFileTypeJs as FileJson,
	IconFileText as FileText,
	IconPhoto as ImageIcon,
	IconX as X,
} from "@tabler/icons-react";
import { useState } from "react";
import { ImageLightbox } from "../image-lightbox.tsx";

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

type FileIconName = "image" | "code" | "data" | "text";

function getFileIconName(filename: string, isImage?: boolean): FileIconName {
	if (isImage) {
		return "image";
	}

	const ext = filename.split(".").pop()?.toLowerCase();

	if (
		[
			"js",
			"ts",
			"jsx",
			"tsx",
			"py",
			"rb",
			"go",
			"rs",
			"java",
			"kt",
			"swift",
			"c",
			"cpp",
			"h",
			"hpp",
			"cs",
			"php",
		].includes(ext || "")
	) {
		return "code";
	}

	if (["json", "yaml", "yml", "xml"].includes(ext || "")) {
		return "data";
	}

	return "text";
}

function renderFileIcon(iconName: FileIconName) {
	switch (iconName) {
		case "image":
			return <ImageIcon className="size-4 text-muted-foreground" />;
		case "code":
			return <FileCode className="size-4 text-muted-foreground" />;
		case "data":
			return <FileJson className="size-4 text-muted-foreground" />;
		default:
			return <FileText className="size-4 text-muted-foreground" />;
	}
}

export function FileAttachment({
	id,
	filename,
	size,
	isImage,
	url,
	onRemove,
	className,
	display = "chip",
	enableImagePreview = true,
}: FileAttachmentProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [isLightboxOpen, setIsLightboxOpen] = useState(false);
	const iconName = getFileIconName(filename, isImage);
	const isImageOnly = display === "image-only" && isImage && !!url;
	const canPreview = Boolean(enableImagePreview && isImage && url);

	const openLightbox = (event: React.MouseEvent) => {
		event.stopPropagation();
		setIsLightboxOpen(true);
	};

	return (
		<div
			className={cn(
				"relative rounded-md bg-muted/50",
				isImageOnly
					? "flex size-10 items-center justify-center"
					: "flex min-w-[120px] max-w-[200px] items-center gap-2 py-1 pr-2 pl-1",
				className
			)}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{isImageOnly ? (
				<div
					className={cn(
						"size-8 shrink-0 overflow-hidden rounded-sm",
						canPreview && "cursor-pointer"
					)}
					onClick={canPreview ? openLightbox : undefined}
				>
					<img
						alt={filename}
						className="h-full w-full object-cover"
						src={url}
					/>
				</div>
			) : (
				<>
					{isImage && url ? (
						<div
							className={cn(
								"w-8 shrink-0 self-stretch overflow-hidden rounded-sm",
								canPreview && "cursor-pointer"
							)}
							onClick={canPreview ? openLightbox : undefined}
						>
							<img
								alt={filename}
								className="aspect-square h-full w-full object-cover"
								src={url}
							/>
						</div>
					) : (
						<div className="flex w-8 shrink-0 items-center justify-center self-stretch rounded-sm bg-muted">
							{renderFileIcon(iconName)}
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
							<span className="text-[10px] text-muted-foreground">
								{formatFileSize(size)}
							</span>
						)}
					</div>
				</>
			)}

			{onRemove && (
				<Button
					className={cn(
						"absolute -top-1.5 -right-1.5 z-10 size-4 rounded-full text-muted-foreground hover:text-foreground",
						isHovered ? "opacity-100" : "opacity-0"
					)}
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					size="icon"
					type="button"
					variant="outline"
				>
					<X className="size-3" />
				</Button>
			)}

			{canPreview && url && (
				<ImageLightbox
					images={[{ id, url, filename }]}
					onClose={() => setIsLightboxOpen(false)}
					open={isLightboxOpen}
				/>
			)}
		</div>
	);
}
