import {
	ArrowDown01Icon,
	Delete02Icon,
	Download01Icon,
	Search01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
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
/** Category chips shown inline; the rest sit behind "More". */
const VISIBLE_CATEGORY_CHIPS = 5;

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
			className="wallpaper-catalog-card flex min-w-0 flex-col gap-2 [contain-intrinsic-size:auto_16rem] [content-visibility:auto]"
			data-testid={`wallpaper-catalog-card-${background.id}`}
		>
			<div
				className="relative aspect-[16/10] overflow-hidden rounded-xl bg-muted"
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
			<div className="min-w-0">
				<div className="flex items-start justify-between gap-2">
					<h3 className="truncate font-medium text-sm" title={background.label}>
						{background.label}
					</h3>
					<span className="shrink-0 text-muted-foreground/70 text-xs">
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
						className="text-muted-foreground text-xs underline underline-offset-2"
						href={background.attributionUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						By {background.attribution}
					</a>
				) : null}
			</div>
			<div className="mt-auto flex items-center gap-2">
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
						variant={installed ? "ghost" : "outline"}
					>
						<HugeiconsIcon
							className="size-4"
							icon={installed ? Tick02Icon : Download01Icon}
						/>
						{installed ? "In Library" : "Install"}
					</Button>
				) : (
					<Button
						className="min-w-0 flex-1"
						onClick={removeWallpaper}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
						Remove
					</Button>
				)}
				<Button
					className="min-w-0 flex-1"
					onClick={useWallpaper}
					size="sm"
					variant="outline"
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

	// At most five chips inline; the active category is always one of them.
	const inlineCategories = categories.slice(0, VISIBLE_CATEGORY_CHIPS);
	if (!inlineCategories.includes(category)) {
		inlineCategories[inlineCategories.length - 1] = category;
	}
	const moreCategories = categories.filter(
		(item) => !inlineCategories.includes(item)
	);
	const chipClass = (active: boolean) =>
		cn(
			"h-8 shrink-0 rounded-lg px-3 text-sm transition-colors duration-(--duration-fast) hover:duration-0",
			active
				? "bg-muted text-foreground"
				: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
		);
	const emptyLibrary = mode === "library" && collection.length === 0;

	return (
		<section
			aria-label={
				mode === "library" ? "Installed wallpapers" : "Marketplace wallpapers"
			}
			className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-hidden px-4 pb-4"
			data-testid={
				mode === "library"
					? "wallpaper-library-section"
					: "wallpaper-marketplace-section"
			}
		>
			<div className="flex shrink-0 flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-48 flex-1 sm:max-w-sm">
						<HugeiconsIcon
							className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
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
						className="text-muted-foreground/70 text-xs tabular-nums"
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
					className="flex items-center gap-1"
					role="group"
				>
					{inlineCategories.map((item) => (
						<button
							aria-pressed={category === item}
							className={chipClass(category === item)}
							key={item}
							onClick={() => setCategory(item)}
							type="button"
						>
							{item}
						</button>
					))}
					{moreCategories.length > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										className="text-muted-foreground"
										size="sm"
										variant="ghost"
									>
										More
										<HugeiconsIcon
											className="size-3.5"
											icon={ArrowDown01Icon}
										/>
									</Button>
								}
							/>
							<DropdownMenuContent align="start" className="min-w-48">
								{moreCategories.map((item) => (
									<DropdownMenuItem
										key={item}
										onClick={() => setCategory(item)}
									>
										{item}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</div>
			{visible.length > 0 ? (
				<div className="min-h-0 flex-1 overflow-y-auto pb-4">
					<div className="grid grid-cols-2 gap-x-4 gap-y-6 xl:grid-cols-3">
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
				<Empty className="py-12">
					<EmptyHeader>
						<EmptyTitle>
							{emptyLibrary
								? "No wallpapers installed yet"
								: "No wallpapers match those filters"}
						</EmptyTitle>
						<EmptyDescription>
							{emptyLibrary
								? "Install a wallpaper from the Marketplace to keep it here."
								: "Try a different search or category."}
						</EmptyDescription>
					</EmptyHeader>
					{emptyLibrary && onBrowseMarketplace ? (
						<EmptyContent>
							<Button onClick={onBrowseMarketplace} size="sm" variant="outline">
								Browse Wallpapers
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			)}
		</section>
	);
}
