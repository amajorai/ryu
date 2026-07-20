// Lets the user personalise a project folder's sidebar glyph: pick a quick
// emoji or upload a custom image/logo. Both are stored inline (emoji string or a
// small downscaled PNG data URL) in the workspace store, keyed by folder path —
// purely desktop-local presentation state, never sent to Core.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { cn } from "@ryu/ui/lib/utils";
import { IconPhotoPlus, IconTrash } from "@tabler/icons-react";
import { type ReactNode, useCallback, useRef } from "react";
import {
	type ProjectIcon,
	useWorkspaceStore,
} from "@/src/store/useWorkspaceStore.ts";

// A folder-flavoured selection; kept short so the grid stays a tidy two rows.
const EMOJI_CHOICES = [
	"📁",
	"📂",
	"🚀",
	"⭐",
	"🔥",
	"💡",
	"🎯",
	"🧪",
	"🛠️",
	"📦",
	"🌐",
	"💻",
	"🎨",
	"📊",
	"🔒",
	"⚡",
	"🤖",
	"🍎",
	"🌱",
	"🧩",
	"📝",
	"🎮",
	"🏗️",
	"🐙",
] as const;

// Downscaled square output keeps localStorage small while staying crisp at the
// tiny sizes the glyph renders at (≈14–16px, retina).
const ICON_OUTPUT_SIZE = 96;

const loadImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", reject);
		image.src = url;
	});

const readFileAsDataUrl = (file: File): Promise<string | null> =>
	new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve((e.target?.result as string) ?? null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});

/** Center-crop an uploaded image to a small square PNG data URL. */
async function fileToIconDataUrl(file: File): Promise<string | null> {
	const dataUrl = await readFileAsDataUrl(file);
	if (!dataUrl) {
		return null;
	}
	const image = await loadImage(dataUrl);
	const side = Math.min(image.naturalWidth, image.naturalHeight);
	const sx = (image.naturalWidth - side) / 2;
	const sy = (image.naturalHeight - side) / 2;

	const canvas = document.createElement("canvas");
	canvas.width = ICON_OUTPUT_SIZE;
	canvas.height = ICON_OUTPUT_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	// PNG (not JPEG) so logos keep transparency and crisp edges.
	ctx.drawImage(
		image,
		sx,
		sy,
		side,
		side,
		0,
		0,
		ICON_OUTPUT_SIZE,
		ICON_OUTPUT_SIZE
	);
	return canvas.toDataURL("image/png");
}

/**
 * Render a project's glyph: its custom emoji/image if set, otherwise `fallback`
 * (typically the default folder Hugeicon). `size` is the square footprint in px.
 */
export function ProjectGlyph({
	icon,
	fallback,
	size = 14,
	className,
}: {
	className?: string;
	fallback: ReactNode;
	icon: ProjectIcon | undefined;
	size?: number;
}) {
	if (icon?.type === "emoji") {
		return (
			<span
				className={cn(
					"flex shrink-0 items-center justify-center leading-none",
					className
				)}
				style={{ width: size, height: size, fontSize: size * 0.92 }}
			>
				{icon.value}
			</span>
		);
	}
	if (icon?.type === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; the icon is an inline data URL
			// biome-ignore lint/correctness/useImageSize: sized via inline width/height style
			<img
				alt=""
				className={cn("shrink-0 rounded-[3px] object-cover", className)}
				src={icon.value}
				style={{ width: size, height: size }}
			/>
		);
	}
	return <>{fallback}</>;
}

/** Emoji-or-upload editor for a single project folder's glyph. Controlled by the
 *  caller (opened from the sidebar's right-click "Change icon…" item). */
export function ProjectIconDialog({
	path,
	name,
	open,
	onOpenChange,
}: {
	name: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	path: string;
}) {
	const { projectIcons, setProjectIcon, clearProjectIcon } =
		useWorkspaceStore();
	const current = projectIcons[path];
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleFile = useCallback(
		async (file: File) => {
			const dataUrl = await fileToIconDataUrl(file);
			if (dataUrl) {
				setProjectIcon(path, { type: "image", value: dataUrl });
				onOpenChange(false);
			}
		},
		[path, setProjectIcon, onOpenChange]
	);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-96">
				<DialogHeader>
					<DialogTitle>Project icon</DialogTitle>
					<DialogDescription className="truncate">{name}</DialogDescription>
				</DialogHeader>

				<div className="grid grid-cols-8 gap-1">
					{EMOJI_CHOICES.map((emoji) => {
						const active = current?.type === "emoji" && current.value === emoji;
						return (
							<button
								aria-label={`Use ${emoji} as the icon`}
								className={cn(
									"flex aspect-square items-center justify-center rounded-md text-lg transition-colors hover:bg-accent",
									active && "bg-accent ring-2 ring-primary"
								)}
								key={emoji}
								onClick={() => {
									setProjectIcon(path, { type: "emoji", value: emoji });
									onOpenChange(false);
								}}
								type="button"
							>
								{emoji}
							</button>
						);
					})}
				</div>

				<div className="flex items-center gap-2">
					<button
						className="flex flex-1 items-center justify-center gap-2 rounded-md border border-border py-2 text-sm transition-colors hover:bg-accent"
						onClick={() => fileInputRef.current?.click()}
						type="button"
					>
						<IconPhotoPlus className="size-4" />
						Upload image…
					</button>
					{current && (
						<button
							aria-label="Remove custom icon"
							className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
							onClick={() => {
								clearProjectIcon(path);
								onOpenChange(false);
							}}
							type="button"
						>
							<IconTrash className="size-4" />
							Reset
						</button>
					)}
				</div>

				<input
					accept="image/jpeg,image/png,image/webp,image/svg+xml"
					aria-label="Upload project icon file"
					className="sr-only"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) {
							handleFile(file);
							e.target.value = "";
						}
					}}
					ref={fileInputRef}
					type="file"
				/>
			</DialogContent>
		</Dialog>
	);
}
