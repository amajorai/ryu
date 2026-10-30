// apps/desktop/src/components/wallpaper/WallpaperPicker.tsx
//
// Notion-style wallpaper chooser used by Settings → Appearance, the OS
// "Customize desktop" dialog and the startup chooser. Five tabs:
// - Gallery  → curated Unsplash sets plus a "Shuffle" tile for random mode.
// - Animated → the universal backdrop registry (shaders, canvas, patterns)
//              with generated customization controls.
// - Unsplash → live, infinitely scrolling search through the node's
//              `/api/assets/images/search` proxy. Without a node Unsplash key
//              it falls back to Openverse.
// - Upload   → a local image, downscaled and stored on this device.
// - Link     → any https image URL.

import { ShuffleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import {
	ALL_WALLPAPER_SETS,
	useWallpaper,
	wallpaperThumbnailUrl,
} from "@/src/lib/wallpaper.ts";
import { BackdropTab } from "./BackdropTab.tsx";
import { GalleryTab } from "./picker/PickerGalleryTab.tsx";
import { SearchTab } from "./picker/PickerSearchTab.tsx";
import { LinkTab, UploadTab } from "./picker/PickerUploadLinkTabs.tsx";

/** Current wallpaper preview with shuffle and credit. */
export function WallpaperPreview() {
	const tl = useLiteralMessages();
	const { preference, shuffle, wallpaper } = useWallpaper();
	return (
		<div className="flex items-center gap-3">
			<div className="relative aspect-[16/10] w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
				{wallpaper.backdrop ? (
					<Backdrop
						id={wallpaper.backdrop.id}
						params={wallpaper.backdrop.params}
						posterOnly
					/>
				) : (
					<img
						alt=""
						className="size-full object-cover"
						src={wallpaperThumbnailUrl(wallpaper.url)}
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm" title={wallpaper.label}>
					{wallpaper.label}
				</p>
				<p className="truncate text-muted-foreground text-xs">
					{preference.mode === "random"
						? tl("Shuffles each launch · {set}", {
								set:
									preference.set === ALL_WALLPAPER_SETS
										? "All wallpapers"
										: preference.set,
							})
						: (wallpaper.attribution ?? wallpaper.set)}
				</p>
			</div>
			<Button onClick={shuffle} size="sm" variant="outline">
				<HugeiconsIcon className="size-3.5" icon={ShuffleIcon} />
				Shuffle
			</Button>
		</div>
	);
}

export function WallpaperPicker({ className }: { className?: string }) {
	const { preference, update } = useWallpaper();
	return (
		<Tabs className={className} defaultValue="gallery">
			<div className="flex flex-col gap-3">
				<TabsList className="w-full justify-start" variant="text">
					<TabsTrigger value="gallery">Gallery</TabsTrigger>
					<TabsTrigger value="animated">Animated</TabsTrigger>
					<TabsTrigger value="unsplash">Unsplash</TabsTrigger>
					<TabsTrigger value="upload">Upload</TabsTrigger>
					<TabsTrigger value="link">Link</TabsTrigger>
				</TabsList>
				<TabsContent value="gallery">
					<GalleryTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="animated">
					<BackdropTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="unsplash">
					<SearchTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="upload">
					<UploadTab update={update} />
				</TabsContent>
				<TabsContent value="link">
					<LinkTab update={update} />
				</TabsContent>
			</div>
		</Tabs>
	);
}
