import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Check, Download, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
	getMarketplaceBackdrops,
	type RenderableBackdrop,
	usePluginBackgrounds,
} from "@/src/lib/plugin-backgrounds.ts";
import {
	DEFAULT_WALLPAPER_PREFERENCE,
	writeWallpaperPreference,
} from "@/src/lib/wallpaper.ts";
import {
	installWallpaper,
	uninstallWallpaper,
	useInstalledWallpaperIds,
} from "@/src/lib/wallpaper-library.ts";

const ALL_CATEGORIES = "All categories";

function WallpaperCard({
	background,
	installed,
	mode,
}: {
	background: RenderableBackdrop;
	installed: boolean;
	mode: "library" | "marketplace";
}) {
	const [hovered, setHovered] = useState(false);

	const useWallpaper = () => {
		if (!(installed || installWallpaper(background.id))) {
			toast.error("Couldn't add this wallpaper to your Library");
			return;
		}
		try {
			writeWallpaperPreference({
				...DEFAULT_WALLPAPER_PREFERENCE,
				backdrop: {
					id: background.id,
					params: background.initialParams,
				},
				mode: "backdrop",
			});
			toast.success("Wallpaper updated");
		} catch {
			toast.error("Couldn't update your wallpaper");
		}
	};

	const removeWallpaper = () => {
		if (!uninstallWallpaper(background.id)) {
			toast.error("Couldn't remove this wallpaper from your Library");
			return;
		}
		toast.success("Wallpaper removed from Library");
	};

	return (
		<article
			className="wallpaper-catalog-card flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card p-2.5"
			data-testid={`wallpaper-catalog-card-${background.id}`}
		>
			<div
				className="relative aspect-[16/10] overflow-hidden rounded-lg bg-muted"
				onBlur={() => setHovered(false)}
				onFocus={() => setHovered(true)}
				onPointerEnter={() => setHovered(true)}
				onPointerLeave={() => setHovered(false)}
			>
				<Backdrop
					definition={background}
					live={hovered}
					posterOnly={!hovered}
				/>
			</div>
			<div className="min-w-0 px-0.5">
				<div className="flex items-start justify-between gap-2">
					<h3 className="truncate font-medium text-sm" title={background.label}>
						{background.label}
					</h3>
					<span className="type-compact shrink-0 text-muted-foreground">
						{background.category}
					</span>
				</div>
				<p
					className="truncate text-muted-foreground text-xs"
					title={background.description}
				>
					{background.description}
				</p>
				{background.attributionUrl ? (
					<a
						className="type-caption text-muted-foreground underline underline-offset-2"
						href={background.attributionUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						By {background.attribution}
					</a>
				) : null}
			</div>
			<div className="mt-auto flex items-center gap-2 pt-1">
				{mode === "marketplace" ? (
					<Button
						className="min-w-0 flex-1"
						disabled={installed}
						onClick={() => {
							if (!installWallpaper(background.id)) {
								toast.error("Couldn't add this wallpaper to your Library");
							}
						}}
						size="sm"
						variant={installed ? "secondary" : "default"}
					>
						{installed ? (
							<Check className="size-3.5" />
						) : (
							<Download className="size-3.5" />
						)}
						{installed ? "In Library" : "Install"}
					</Button>
				) : (
					<Button
						className="min-w-0 flex-1"
						onClick={removeWallpaper}
						size="sm"
						variant="outline"
					>
						<Trash2 className="size-3.5" />
						Remove
					</Button>
				)}
				<Button
					className="min-w-0 flex-1"
					onClick={useWallpaper}
					size="sm"
					variant={mode === "marketplace" ? "outline" : "default"}
				>
					Use wallpaper
				</Button>
			</div>
		</article>
	);
}

export function WallpaperCatalogSection({
	initialQuery = "",
	mode,
	onBrowseMarketplace,
}: {
	initialQuery?: string;
	mode: "library" | "marketplace";
	onBrowseMarketplace?: () => void;
}) {
	const tl = useLiteralMessages();
	const pluginBackgrounds = usePluginBackgrounds();
	const installedIds = useInstalledWallpaperIds();
	const installed = useMemo(() => new Set(installedIds), [installedIds]);
	const allBackgrounds = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const collection = useMemo(
		() =>
			mode === "library"
				? allBackgrounds.filter((background) => installed.has(background.id))
				: allBackgrounds,
		[allBackgrounds, installed, mode]
	);
	const [category, setCategory] = useState(ALL_CATEGORIES);
	const [query, setQuery] = useState(initialQuery);
	const normalizedQuery = query.trim().toLowerCase();
	const categories = useMemo(
		() => [
			ALL_CATEGORIES,
			...new Set(collection.map((background) => background.category)),
		],
		[collection]
	);
	const visible = useMemo(
		() =>
			collection.filter((background) => {
				const matchesCategory =
					category === ALL_CATEGORIES || background.category === category;
				const searchable =
					`${background.label} ${background.description} ${background.attribution ?? ""}`.toLowerCase();
				return (
					matchesCategory &&
					(!normalizedQuery || searchable.includes(normalizedQuery))
				);
			}),
		[category, collection, normalizedQuery]
	);

	return (
		<section
			aria-label={
				mode === "library" ? "Installed wallpapers" : "Marketplace wallpapers"
			}
			className="flex h-full min-h-0 flex-col gap-4 overflow-hidden px-4 pb-4"
			data-testid={
				mode === "library"
					? "wallpaper-library-section"
					: "wallpaper-marketplace-section"
			}
		>
			<header className="shrink-0 space-y-1">
				<h1 className="font-semibold text-xl">Wallpapers</h1>
				<p className="text-muted-foreground text-sm">
					{mode === "library"
						? "Wallpapers installed on this device."
						: "Install adds a wallpaper to Library. Use wallpaper applies it now and adds it there."}
				</p>
			</header>
			<div className="shrink-0 space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-48 flex-1 sm:max-w-sm">
						<Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							aria-label="Search wallpapers"
							data-testid="wallpaper-catalog-search"
							leadingAdornment="compact"
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search wallpapers"
							value={query}
						/>
					</div>
					<p
						aria-live="polite"
						className="text-muted-foreground text-xs"
						data-testid="wallpaper-catalog-count"
					>
						{tl("{shown} of {total} wallpapers", {
							shown: visible.length,
							total: collection.length,
						})}
					</p>
				</div>
				<div
					aria-label="Wallpaper categories"
					className="flex flex-wrap gap-1.5"
					role="group"
				>
					{categories.map((item) => (
						<button
							aria-pressed={category === item}
							className={cn(
								"rounded-full border px-2.5 py-1 text-xs transition-colors",
								category === item
									? "border-primary bg-primary text-primary-foreground"
									: "border-border bg-background hover:bg-muted"
							)}
							key={item}
							onClick={() => setCategory(item)}
							type="button"
						>
							{item}
						</button>
					))}
				</div>
			</div>
			{visible.length > 0 ? (
				<div className="min-h-0 flex-1 overflow-y-auto pb-4">
					<div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
						{visible.map((background) => (
							<WallpaperCard
								background={background}
								installed={installed.has(background.id)}
								key={background.id}
								mode={mode}
							/>
						))}
					</div>
				</div>
			) : (
				<div className="flex min-h-48 flex-1 items-center justify-center rounded-xl border border-dashed p-6 text-center">
					<div className="max-w-sm space-y-2">
						<p className="font-medium">
							{mode === "library" && collection.length === 0
								? "No wallpapers installed yet"
								: "No wallpapers match those filters"}
						</p>
						<p className="text-muted-foreground text-sm">
							{mode === "library" && collection.length === 0
								? "Install a wallpaper from the Marketplace tab to keep it here."
								: "Try a different search or category."}
						</p>
						{mode === "library" &&
						collection.length === 0 &&
						onBrowseMarketplace ? (
							<Button className="mt-1" onClick={onBrowseMarketplace} size="sm">
								Browse Wallpapers
							</Button>
						) : null}
					</div>
				</div>
			)}
		</section>
	);
}
