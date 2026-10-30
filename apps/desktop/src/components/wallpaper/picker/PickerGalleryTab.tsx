import { ShuffleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ALL_WALLPAPER_SETS,
	type OsWallpaper,
	WALLPAPER_SETS,
	type WallpaperPreference,
	wallpapersInSet,
	wallpaperThumbnailUrl,
} from "@/src/lib/wallpaper.ts";

export function Tile({
	children,
	className,
	label,
	onClick,
	selected,
}: {
	children: React.ReactNode;
	className?: string;
	label: string;
	onClick: () => void;
	selected: boolean;
}) {
	return (
		<button
			aria-label={label}
			aria-pressed={selected}
			className={cn(
				"group relative aspect-[16/10] overflow-hidden rounded-xl bg-muted outline-none ring-offset-2 ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring",
				selected && "ring-2 ring-foreground",
				className
			)}
			onClick={onClick}
			title={label}
			type="button"
		>
			{children}
			{selected ? (
				<span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
					<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
				</span>
			) : null}
		</button>
	);
}

export function Thumb({ alt, src }: { alt: string; src: string }) {
	return (
		<img
			alt={alt}
			className="size-full object-cover"
			decoding="async"
			loading="lazy"
			src={src}
		/>
	);
}

export function saveOrWarn(apply: () => void): boolean {
	try {
		apply();
		return true;
	} catch (error) {
		toast.error({
			title: "Couldn't save wallpaper",
			description:
				error instanceof DOMException && error.name === "QuotaExceededError"
					? "That image is too large to keep on this device. Try a smaller one."
					: "Please try again.",
		});
		return false;
	}
}

export function GalleryTab({
	preference,
	update,
}: {
	preference: WallpaperPreference;
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const randomSelected = preference.mode === "random";
	const sets = [ALL_WALLPAPER_SETS, ...WALLPAPER_SETS];
	return (
		<div className="space-y-4">
			<div>
				<p className="mb-2 font-medium text-muted-foreground text-xs">
					Shuffle a new wallpaper every launch
				</p>
				<div className="flex flex-wrap gap-1.5">
					{sets.map((set) => {
						const active = randomSelected && preference.set === set;
						return (
							<button
								aria-pressed={active}
								className={cn(
									"inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors duration-(--duration-fast) hover:duration-0",
									active
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
								)}
								key={set}
								onClick={() => update({ mode: "random", set })}
								type="button"
							>
								{set === ALL_WALLPAPER_SETS ? (
									<HugeiconsIcon className="size-3.5" icon={ShuffleIcon} />
								) : null}
								{set === ALL_WALLPAPER_SETS ? "All wallpapers" : set}
							</button>
						);
					})}
				</div>
			</div>
			{WALLPAPER_SETS.map((set) => (
				<section key={set}>
					<h4 className="mb-2 font-medium text-muted-foreground text-xs">
						{set}
					</h4>
					<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
						{wallpapersInSet(set).map((item: OsWallpaper) => (
							<Tile
								key={item.id}
								label={item.label}
								onClick={() =>
									update({ mode: "preset", presetId: item.id, set })
								}
								selected={
									preference.mode === "preset" &&
									preference.presetId === item.id
								}
							>
								<Thumb alt="" src={wallpaperThumbnailUrl(item.url)} />
							</Tile>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
