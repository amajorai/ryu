// A clickable agent avatar that opens a picker offering three mutually-exclusive
// avatar sources:
//
//   • Upload — pick a local image, crop it to a square (center crop + zoom), and
//     store the result inline as a 256×256 JPEG data URL (persona.avatar_url).
//   • Icon   — any icon id resolved through the shared Icon primitive (an
//     Iconify / icons0 / Hugeicons id), stored on persona.icon.
//   • Dither — a dither-gradient built from the shared dither-kit (a `from`
//     palette colour, an optional `to` colour, and a direction), stored on
//     persona.dither.
//
// The picked value is handed back via `onChange` as a discriminated union so the
// parent can route it to the right persona slot (setting one source clears the
// others). When no custom avatar is set, the provided `fallback` (the engine
// logo) is shown instead.
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
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient";
import {
	type DitherColor,
	isDitherColor,
	PALETTE,
	rgb,
} from "@ryu/ui/components/dither-kit/palette";
import { Icon } from "@ryu/ui/components/icon";
import { Input } from "@ryu/ui/components/input";
import { Slider } from "@ryu/ui/components/slider";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconArrowDown,
	IconArrowLeft,
	IconArrowRight,
	IconArrowUp,
	IconPhotoPlus,
	IconX,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface Dimensions {
	height: number;
	width: number;
}

/** A dither-gradient avatar as handed back by the field. */
export interface AgentDitherValue {
	direction: GradientDirection;
	from: DitherColor;
	/** Second palette colour, or null for a fade to transparent. */
	to: DitherColor | null;
}

/**
 * The three mutually-exclusive avatar sources (or null for "no custom avatar").
 * The parent maps each `kind` onto the matching persona slot.
 */
export type AgentAvatarValue =
	| { kind: "image"; dataUrl: string }
	| { kind: "icon"; id: string }
	| { kind: "dither"; dither: AgentDitherValue }
	| null;

interface AgentImageFieldProps {
	className?: string;
	disabled?: boolean;
	/** Rendered when no custom avatar is set (typically the engine logo). */
	fallback: ReactNode;
	/** Called with the picked avatar source, or null when removed. */
	onChange: (value: AgentAvatarValue) => void;
	/** Current avatar value across all three sources, or null. */
	value: AgentAvatarValue;
}

const OUTPUT_SIZE = 256;
const MAX_ZOOM = 3;

const DITHER_COLORS: DitherColor[] = [
	"green",
	"blue",
	"purple",
	"pink",
	"orange",
	"red",
	"grey",
];

const DIRECTION_OPTIONS: {
	value: GradientDirection;
	label: string;
	Icon: typeof IconArrowUp;
}[] = [
	{ value: "up", label: "Up", Icon: IconArrowUp },
	{ value: "down", label: "Down", Icon: IconArrowDown },
	{ value: "left", label: "Left", Icon: IconArrowLeft },
	{ value: "right", label: "Right", Icon: IconArrowRight },
];

const DEFAULT_DITHER: AgentDitherValue = {
	from: "green",
	to: null,
	direction: "up",
};

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

/** Which picker tab a stored value opens on. */
function tabForValue(value: AgentAvatarValue): "upload" | "icon" | "dither" {
	if (value?.kind === "icon") {
		return "icon";
	}
	if (value?.kind === "dither") {
		return "dither";
	}
	return "upload";
}

/**
 * The resting avatar shown on the field's button: the picked source when set,
 * otherwise the provided fallback (engine logo).
 */
function AvatarDisplay({
	value,
	fallback,
}: {
	value: AgentAvatarValue;
	fallback: ReactNode;
}) {
	if (value?.kind === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; avatar is an inline data URL
			// biome-ignore lint/correctness/useImageSize: sized via the `size-full` class
			<img
				alt="Agent avatar"
				className="size-full rounded-lg object-cover"
				src={value.dataUrl}
			/>
		);
	}
	if (value?.kind === "icon") {
		return (
			<span className="flex size-full items-center justify-center text-foreground">
				<Icon className="size-1/2" icon={value.id} />
			</span>
		);
	}
	if (value?.kind === "dither") {
		return (
			<span className="relative block size-full overflow-hidden rounded-lg">
				<DitherGradient
					direction={value.dither.direction}
					from={value.dither.from}
					to={value.dither.to ?? "transparent"}
				/>
			</span>
		);
	}
	return <>{fallback}</>;
}

export function AgentImageField({
	value,
	onChange,
	fallback,
	disabled = false,
	className,
}: AgentImageFieldProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const [tab, setTab] = useState<"upload" | "icon" | "dither">("upload");

	// ── Upload / crop state ──────────────────────────────────────────────────────
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	// The preview image's rendered (CSS-pixel) size, measured on load. Used only
	// to size the crop guide overlay; the actual crop uses natural pixels.
	const [rendered, setRendered] = useState<Dimensions | null>(null);
	const [zoom, setZoom] = useState(1);

	// ── Icon state ───────────────────────────────────────────────────────────────
	const [iconDraft, setIconDraft] = useState("");

	// ── Dither state ─────────────────────────────────────────────────────────────
	const [dither, setDither] = useState<AgentDitherValue>(DEFAULT_DITHER);

	// Seed the drafts from the current value whenever the dialog opens so the
	// picker reflects what is already saved instead of blank defaults.
	useEffect(() => {
		if (!isDialogOpen) {
			return;
		}
		setTab(tabForValue(value));
		setPreviewUrl(null);
		setRendered(null);
		setZoom(1);
		setIconDraft(value?.kind === "icon" ? value.id : "");
		if (value?.kind === "dither") {
			setDither({
				from: isDitherColor(value.dither.from) ? value.dither.from : "green",
				to: isDitherColor(value.dither.to) ? value.dither.to : null,
				direction: value.dither.direction,
			});
		} else {
			setDither(DEFAULT_DITHER);
		}
	}, [isDialogOpen, value]);

	const handleFileSelect = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			setPreviewUrl((e.target?.result as string) ?? null);
			setRendered(null);
			setZoom(1);
		};
		reader.readAsDataURL(file);
	}, []);

	const applyImage = useCallback(async () => {
		if (!previewUrl) {
			return;
		}
		const dataUrl = await cropToDataUrl(previewUrl, zoom);
		if (dataUrl) {
			onChange({ kind: "image", dataUrl });
		}
		setIsDialogOpen(false);
	}, [previewUrl, zoom, onChange]);

	const applyIcon = useCallback(() => {
		const id = iconDraft.trim();
		if (!id) {
			return;
		}
		onChange({ kind: "icon", id });
		setIsDialogOpen(false);
	}, [iconDraft, onChange]);

	const applyDither = useCallback(() => {
		onChange({ kind: "dither", dither });
		setIsDialogOpen(false);
	}, [dither, onChange]);

	// Side of the circular crop guide in rendered pixels (centered on the image).
	const guideSide = rendered
		? Math.min(rendered.width, rendered.height) / zoom
		: 0;

	return (
		<>
			<div className={cn("relative", className)}>
				<button
					aria-label={value ? "Change agent avatar" : "Set agent avatar"}
					className="group/agent-image relative flex size-full items-center justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					disabled={disabled}
					onClick={() => setIsDialogOpen(true)}
					type="button"
				>
					<AvatarDisplay fallback={fallback} value={value} />
					{!disabled && (
						<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/agent-image:opacity-100">
							<IconPhotoPlus className="size-4" />
						</span>
					)}
				</button>
				{value && !disabled && (
					<Button
						aria-label="Remove agent avatar"
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

			<Dialog onOpenChange={setIsDialogOpen} open={isDialogOpen}>
				<DialogContent className="gap-0 p-0 sm:max-w-140 *:[button]:hidden">
					<DialogDescription className="sr-only">
						Choose an avatar for the agent
					</DialogDescription>
					<DialogHeader className="contents space-y-0 text-left">
						<DialogTitle className="border-b p-4 text-base">
							Agent avatar
						</DialogTitle>
					</DialogHeader>

					<Tabs
						className="p-4"
						onValueChange={(v) => setTab(v as "upload" | "icon" | "dither")}
						value={tab}
					>
						<TabsList className="w-full">
							<TabsTrigger value="upload">Upload</TabsTrigger>
							<TabsTrigger value="icon">Icon</TabsTrigger>
							<TabsTrigger value="dither">Dither</TabsTrigger>
						</TabsList>

						{/* ── Upload ── */}
						<TabsContent className="pt-4" value="upload">
							{previewUrl ? (
								<div className="space-y-4">
									<div className="flex h-72 items-center justify-center overflow-hidden rounded-lg bg-muted/30">
										<div className="relative inline-flex">
											{/* biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; preview is an inline data URL */}
											{/* biome-ignore lint/correctness/useImageSize: preview scales to fit via object-contain; intrinsic size is unknown */}
											{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onLoad measures the rendered size to size the crop guide */}
											<img
												alt="Crop preview"
												className="block max-h-72 max-w-full object-contain"
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
									<div className="flex items-center gap-4">
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
								</div>
							) : (
								<button
									className="flex h-72 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => fileInputRef.current?.click()}
									type="button"
								>
									<IconPhotoPlus className="size-6" />
									<span>Choose an image to crop</span>
								</button>
							)}
						</TabsContent>

						{/* ── Icon ── */}
						<TabsContent className="pt-4" value="icon">
							<div className="space-y-4">
								<div className="flex h-40 items-center justify-center rounded-lg bg-muted/30">
									{iconDraft.trim() ? (
										<Icon
											className="size-16 text-foreground"
											icon={iconDraft}
										/>
									) : (
										<span className="text-muted-foreground text-sm">
											Preview
										</span>
									)}
								</div>
								<div className="space-y-1.5">
									<Input
										aria-label="Icon id"
										onChange={(e) => setIconDraft(e.target.value)}
										placeholder="e.g. lucide:sparkles, mdi:robot, ai-image"
										value={iconDraft}
									/>
									<p className="text-muted-foreground text-xs">
										An Iconify / icons0 id (<code>prefix:name</code>) or a bare
										Hugeicons name.
									</p>
								</div>
							</div>
						</TabsContent>

						{/* ── Dither ── */}
						<TabsContent className="pt-4" value="dither">
							<div className="space-y-4">
								<div className="flex h-40 items-center justify-center rounded-lg bg-muted/30">
									<span className="relative block size-24 overflow-hidden rounded-full ring-1 ring-border">
										<DitherGradient
											direction={dither.direction}
											from={dither.from}
											to={dither.to ?? "transparent"}
										/>
									</span>
								</div>

								<div className="space-y-1.5">
									<span className="text-muted-foreground text-xs">Colour</span>
									<div className="flex flex-wrap gap-2">
										{DITHER_COLORS.map((color) => (
											<button
												aria-label={color}
												aria-pressed={dither.from === color}
												className={cn(
													"size-7 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
													dither.from === color
														? "ring-2 ring-foreground"
														: "ring-1 ring-border"
												)}
												key={color}
												onClick={() =>
													setDither((d) => ({ ...d, from: color }))
												}
												style={{ backgroundColor: rgb(PALETTE[color].fill) }}
												type="button"
											/>
										))}
									</div>
								</div>

								<div className="space-y-1.5">
									<span className="text-muted-foreground text-xs">
										Blend to (optional)
									</span>
									<div className="flex flex-wrap items-center gap-2">
										<button
											aria-label="Fade to transparent"
											aria-pressed={dither.to === null}
											className={cn(
												"flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
												dither.to === null
													? "ring-2 ring-foreground"
													: "ring-1 ring-border"
											)}
											onClick={() => setDither((d) => ({ ...d, to: null }))}
											type="button"
										>
											<IconX className="size-3.5" />
										</button>
										{DITHER_COLORS.map((color) => (
											<button
												aria-label={`Blend to ${color}`}
												aria-pressed={dither.to === color}
												className={cn(
													"size-7 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
													dither.to === color
														? "ring-2 ring-foreground"
														: "ring-1 ring-border"
												)}
												key={color}
												onClick={() => setDither((d) => ({ ...d, to: color }))}
												style={{ backgroundColor: rgb(PALETTE[color].fill) }}
												type="button"
											/>
										))}
									</div>
								</div>

								<div className="space-y-1.5">
									<span className="text-muted-foreground text-xs">
										Direction
									</span>
									<div className="flex gap-2">
										{DIRECTION_OPTIONS.map((opt) => (
											<button
												aria-label={opt.label}
												aria-pressed={dither.direction === opt.value}
												className={cn(
													"flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
													dither.direction === opt.value
														? "bg-foreground text-background"
														: "bg-muted text-muted-foreground hover:bg-muted/70"
												)}
												key={opt.value}
												onClick={() =>
													setDither((d) => ({ ...d, direction: opt.value }))
												}
												type="button"
											>
												<opt.Icon className="size-4" />
											</button>
										))}
									</div>
								</div>
							</div>
						</TabsContent>
					</Tabs>

					<DialogFooter className="border-t px-4 py-4">
						{tab === "upload" && (
							<Button disabled={!previewUrl} onClick={applyImage} type="button">
								Apply
							</Button>
						)}
						{tab === "icon" && (
							<Button
								disabled={!iconDraft.trim()}
								onClick={applyIcon}
								type="button"
							>
								Use icon
							</Button>
						)}
						{tab === "dither" && (
							<Button onClick={applyDither} type="button">
								Use gradient
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
