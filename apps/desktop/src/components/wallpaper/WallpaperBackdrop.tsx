// apps/desktop/src/components/wallpaper/WallpaperBackdrop.tsx
//
// The full-bleed wallpaper layer shared by OS and the startup chooser. A
// solid color plus gradient always sits underneath, so the first screen still
// looks intentional offline or while a remote image is loading; the image fades
// in once decoded and is dropped entirely if it fails. Animated wallpapers come
// from the universal backdrop registry and run live here, since this is the one
// full-screen surface that can afford a GPU context.

import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import { backdropByAvailableId } from "@/src/lib/plugin-backgrounds.ts";
import type { OsWallpaper } from "@/src/lib/wallpaper.ts";

export function WallpaperBackdrop({
	className,
	live = true,
	wallpaper,
}: {
	className?: string;
	/** Animate backdrop wallpapers. Thumbnails pass false. */
	live?: boolean;
	wallpaper: OsWallpaper;
}) {
	const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const failed = failedUrl === wallpaper.url;
	const definition = wallpaper.backdrop
		? backdropByAvailableId(wallpaper.backdrop.id)
		: undefined;
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 overflow-hidden bg-wallpaper-base",
				className
			)}
			data-wallpaper-id={wallpaper.id}
		>
			<div className="absolute inset-0 bg-gradient-to-br from-wallpaper-gradient-start via-wallpaper-gradient-mid to-wallpaper-gradient-end" />
			{wallpaper.backdrop && definition ? (
				<Backdrop
					definition={definition}
					live={live}
					params={wallpaper.backdrop.params}
				/>
			) : null}
			{!(wallpaper.backdrop || failed) && wallpaper.url ? (
				<img
					alt=""
					className={cn(
						"absolute inset-0 size-full object-cover transition-opacity duration-700 motion-reduce:transition-none",
						loadedUrl === wallpaper.url ? "opacity-100" : "opacity-0"
					)}
					decoding="async"
					key={wallpaper.url}
					loading="eager"
					onError={() => setFailedUrl(wallpaper.url)}
					onLoad={() => setLoadedUrl(wallpaper.url)}
					src={wallpaper.url}
				/>
			) : null}
		</div>
	);
}
