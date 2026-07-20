// A clickable agent avatar that lets the user pick a local image, crop it to a
// square (center crop + zoom-to-tighten), and store the result inline as a data
// URL. Unlike the settings AvatarUploadCropper this never uploads to a server —
// the cropped 256×256 JPEG data URL is handed back via `onChange` and persisted
// on the agent's `persona.avatar_url` slot. When no custom image is set, the
// provided `fallback` (the engine logo) is shown instead.
//
// The crop is computed in the image's *natural* pixel space (not the rendered
// preview size), so the saved image is always a correct centered square at full
// resolution. `zoom` shrinks the selected square about the center, so higher
// zoom = a tighter crop.

import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Slider } from "@ryu/ui/components/slider";
import { cn } from "@ryu/ui/lib/utils";
import { IconPhotoPlus, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

interface Dimensions {
	height: number;
	width: number;
}

interface AgentImageFieldProps {
	className?: string;
	disabled?: boolean;
	/** Rendered when no custom image is set (typically the engine logo). */
	fallback: ReactNode;
	/** Called with the cropped image as a JPEG data URL, or null when removed. */
	onChange: (dataUrl: string | null) => void;
	/** Current custom image (data URL), or null. */
	value: string | null;
}

const OUTPUT_SIZE = 256;
const MAX_ZOOM = 3;

const loadImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", reject);
		image.src = url;
	});

/**
 * Crop the centered square (side = min(w, h) / zoom) out of the source image at
 * its natural resolution and return it as a square JPEG data URL.
 */
async function cropToDataUrl(
	imageSrc: string,
	zoom: number
): Promise<string | null> {
	const image = await loadImage(imageSrc);
	const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
	const sx = (image.naturalWidth - side) / 2;
	const sy = (image.naturalHeight - side) / 2;

	const canvas = document.createElement("canvas");
	canvas.width = OUTPUT_SIZE;
	canvas.height = OUTPUT_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(image, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
	return canvas.toDataURL("image/jpeg", 0.9);
}

export function AgentImageField({
	value,
	onChange,
	fallback,
	disabled = false,
	className,
}: AgentImageFieldProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	// The preview image's rendered (CSS-pixel) size, measured on load. Used only
	// to size the crop guide overlay; the actual crop uses natural pixels.
	const [rendered, setRendered] = useState<Dimensions | null>(null);
	const [zoom, setZoom] = useState(1);
	const [isDialogOpen, setIsDialogOpen] = useState(false);

	const handleFileSelect = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			setPreviewUrl((e.target?.result as string) ?? null);
			setRendered(null);
			setZoom(1);
			setIsDialogOpen(true);
		};
		reader.readAsDataURL(file);
	}, []);

	const handleApply = useCallback(async () => {
		if (!previewUrl) {
			setIsDialogOpen(false);
			return;
		}
		const dataUrl = await cropToDataUrl(previewUrl, zoom);
		if (dataUrl) {
			onChange(dataUrl);
		}
		setIsDialogOpen(false);
		setPreviewUrl(null);
	}, [previewUrl, zoom, onChange]);

	// Side of the circular crop guide in rendered pixels (centered on the image).
	const guideSide = rendered
		? Math.min(rendered.width, rendered.height) / zoom
		: 0;

	return (
		<>
			<div className={cn("relative", className)}>
				<button
					aria-label={value ? "Change agent image" : "Upload agent image"}
					className="group/agent-image relative flex size-full items-center justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					disabled={disabled}
					onClick={() => fileInputRef.current?.click()}
					type="button"
				>
					{value ? (
						// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; avatar is an inline data URL
						// biome-ignore lint/correctness/useImageSize: sized via the `size-full` class
						<img
							alt="Agent avatar"
							className="size-full rounded-lg object-cover"
							src={value}
						/>
					) : (
						fallback
					)}
					{!disabled && (
						<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/agent-image:opacity-100">
							<IconPhotoPlus className="size-4" />
						</span>
					)}
				</button>
				{value && !disabled && (
					<Button
						aria-label="Remove agent image"
						className="absolute -top-1.5 -right-1.5 size-5 rounded-full border-2 border-background p-0 shadow-none"
						onClick={() => onChange(null)}
						size="icon"
						type="button"
					>
						<IconX className="size-3" />
					</Button>
				)}
				<input
					accept="image/jpeg,image/png,image/webp"
					aria-label="Upload agent image file"
					className="sr-only"
					disabled={disabled}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) {
							handleFileSelect(file);
							e.target.value = "";
						}
					}}
					ref={fileInputRef}
					type="file"
				/>
			</div>

			<Dialog
				onOpenChange={(open: boolean) => {
					setIsDialogOpen(open);
					if (!open) {
						setPreviewUrl(null);
					}
				}}
				open={isDialogOpen}
			>
				<DialogContent className="gap-0 p-0 sm:max-w-140 *:[button]:hidden">
					<DialogDescription className="sr-only">
						Crop the agent image to a square
					</DialogDescription>
					<DialogHeader className="contents space-y-0 text-left">
						<DialogTitle className="flex items-center justify-between border-b p-4 text-base">
							<span>Crop image</span>
							<Button
								autoFocus
								disabled={!previewUrl}
								onClick={handleApply}
								type="button"
							>
								Apply
							</Button>
						</DialogTitle>
					</DialogHeader>
					{previewUrl && (
						<div className="flex h-96 items-center justify-center overflow-hidden bg-muted/30 sm:h-120">
							<div className="relative inline-flex">
								{/* biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; preview is an inline data URL */}
								{/* biome-ignore lint/correctness/useImageSize: preview scales to fit via object-contain; intrinsic size is unknown */}
								{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad measures the rendered size to size the crop guide */}
								<img
									alt="Crop preview"
									className="block max-h-80 max-w-full object-contain sm:max-h-[26rem]"
									onLoad={(e) => {
										const img = e.currentTarget;
										setRendered({
											width: img.clientWidth,
											height: img.clientHeight,
										});
									}}
									src={previewUrl}
								/>
								{guideSide > 0 && (
									<div
										className="pointer-events-none absolute rounded-full border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]"
										style={{
											left: "50%",
											top: "50%",
											width: guideSide,
											height: guideSide,
											transform: "translate(-50%, -50%)",
										}}
									/>
								)}
							</div>
						</div>
					)}
					<DialogFooter className="border-t px-4 py-6">
						<div className="mx-auto flex w-full max-w-80 items-center gap-4">
							<span className="text-muted-foreground text-xs">Zoom</span>
							<Slider
								aria-label="Zoom"
								max={MAX_ZOOM}
								min={1}
								onValueChange={(v: number | number[]) =>
									setZoom(Array.isArray(v) ? v[0] : v)
								}
								step={0.1}
								value={[zoom]}
							/>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
