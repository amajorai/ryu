// apps/desktop/src/components/wallpaper/BackdropTab.tsx
//
// "Animated" wallpaper tab: every entry in the universal backdrop registry,
// grouped by category. Grid tiles are static CSS posters; only the tile under
// the pointer animates, because browsers cap live WebGL contexts (~16) and a
// grid of live shaders would evict the desktop's own wallpaper. The selected
// backdrop gets a live preview and its generated customization controls.

import { Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { BackdropControls } from "@ryu/ui/components/backdrop/backdrop-controls.tsx";
import { BACKDROP_CATEGORIES } from "@ryu/ui/components/backdrop/definitions.ts";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import {
	getAvailableBackdrops,
	getMarketplaceBackdrops,
	type RenderableBackdrop,
	usePluginBackgrounds,
} from "@/src/lib/plugin-backgrounds.ts";
import type { WallpaperPreference } from "@/src/lib/wallpaper.ts";

const ALL = "All";
const ALL_MARKETPLACE_CATEGORIES = "All categories";
const MARKETPLACE = "Marketplace";

function BackdropTile({
	definition,
	onSelect,
	selected,
}: {
	definition: RenderableBackdrop;
	onSelect: () => void;
	selected: boolean;
}) {
	const [hovered, setHovered] = useState(false);
	return (
		<button
			aria-label={definition.label}
			aria-pressed={selected}
			className={cn(
				"group relative flex flex-col gap-1.5 text-left outline-none",
				"focus-visible:[&>span:first-child]:ring-2 focus-visible:[&>span:first-child]:ring-ring"
			)}
			data-testid={`backdrop-tile-${definition.id}`}
			onBlur={() => setHovered(false)}
			onClick={onSelect}
			onFocus={() => setHovered(true)}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			title={definition.description}
			type="button"
		>
			<span
				className={cn(
					"relative aspect-[16/10] w-full overflow-hidden rounded-xl bg-muted ring-offset-2 ring-offset-background",
					selected && "ring-2 ring-primary"
				)}
			>
				<Backdrop
					definition={definition}
					live={hovered}
					posterOnly={!hovered}
				/>
				{selected ? (
					<span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
						<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
					</span>
				) : null}
			</span>
			<span className="truncate font-medium text-xs" title={definition.label}>
				{definition.label}
			</span>
			{definition.attribution ? (
				<span className="truncate text-muted-foreground text-xs">
					By {definition.attribution}
				</span>
			) : null}
		</button>
	);
}

export function BackdropTab({
	preference,
	update,
}: {
	preference: WallpaperPreference;
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const tl = useLiteralMessages();
	const [category, setCategory] = useState<string>(ALL);
	const [marketplaceCategory, setMarketplaceCategory] = useState<string>(
		ALL_MARKETPLACE_CATEGORIES
	);
	const [marketplaceQuery, setMarketplaceQuery] = useState("");
	const pluginBackgrounds = usePluginBackgrounds();
	const backdrops = getAvailableBackdrops(pluginBackgrounds);
	const marketplaceBackdrops = getMarketplaceBackdrops(pluginBackgrounds);
	const selected =
		preference.mode === "backdrop" && preference.backdrop
			? backdrops.find((backdrop) => backdrop.id === preference.backdrop?.id)
			: undefined;
	const categories = BACKDROP_CATEGORIES.filter((item) =>
		backdrops.some((backdrop) => backdrop.category === item)
	);
	const marketplaceCategories = [
		ALL_MARKETPLACE_CATEGORIES,
		...new Set(marketplaceBackdrops.map((item) => item.category)),
	];
	const normalizedMarketplaceQuery = marketplaceQuery.trim().toLowerCase();
	const visible =
		category === MARKETPLACE
			? marketplaceBackdrops.filter((item) => {
					const matchesCategory =
						marketplaceCategory === ALL_MARKETPLACE_CATEGORIES ||
						item.category === marketplaceCategory;
					const searchableText =
						`${item.label} ${item.description} ${item.attribution ?? ""}`.toLowerCase();
					return (
						matchesCategory &&
						(!normalizedMarketplaceQuery ||
							searchableText.includes(normalizedMarketplaceQuery))
					);
				})
			: category === ALL
				? backdrops
				: backdrops.filter((item) => item.category === category);
	const categoryTabs =
		category === MARKETPLACE
			? [ALL, MARKETPLACE]
			: [
					ALL,
					...categories,
					...(marketplaceBackdrops.length > 0 ? [MARKETPLACE] : []),
				];

	return (
		<div className="space-y-4">
			{selected && preference.backdrop ? (
				<section
					className="grid gap-4 rounded-2xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]"
					data-testid="backdrop-customize"
				>
					<div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
						<Backdrop
							definition={selected}
							live
							params={preference.backdrop.params}
						/>
						<span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-white text-xs">
							{selected.label}
						</span>
					</div>
					<div className="max-h-72 overflow-y-auto pr-1">
						{selected.origin === "marketplace" && selected.attributionUrl ? (
							<p className="mb-3 text-muted-foreground text-xs">
								Source:{" "}
								<a
									className="font-medium text-foreground underline underline-offset-2"
									href={selected.attributionUrl}
									rel="noopener noreferrer"
									target="_blank"
								>
									{selected.attribution}
								</a>
							</p>
						) : null}
						<BackdropControls
							definition={selected}
							onChange={(params) =>
								update({
									backdrop: { id: selected.id, params },
									mode: "backdrop",
								})
							}
							params={preference.backdrop.params}
						/>
					</div>
				</section>
			) : null}

			<div
				aria-label="Backdrop categories"
				className="flex flex-wrap gap-1.5"
				role="tablist"
			>
				{categoryTabs.map((item) => (
					<button
						aria-selected={category === item}
						className={cn(
							"rounded-full border px-2.5 py-1 text-xs transition-colors",
							category === item
								? "border-primary bg-primary text-primary-foreground"
								: "border-border bg-background hover:bg-muted"
						)}
						key={item}
						onClick={() => setCategory(item)}
						role="tab"
						type="button"
					>
						{item}
					</button>
				))}
			</div>

			{category === MARKETPLACE ? (
				<div className="space-y-3" data-testid="marketplace-wallpaper-filters">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1 sm:max-w-sm">
							<HugeiconsIcon
								aria-hidden="true"
								className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search Marketplace wallpapers"
								data-testid="marketplace-wallpaper-search"
								leadingAdornment="compact"
								onChange={(event) => setMarketplaceQuery(event.target.value)}
								placeholder="Search wallpapers"
								value={marketplaceQuery}
							/>
						</div>
						<p
							aria-live="polite"
							className="text-muted-foreground text-xs"
							data-testid="marketplace-wallpaper-count"
						>
							{tl("{shown} of {total} wallpapers", {
								shown: visible.length,
								total: marketplaceBackdrops.length,
							})}
						</p>
					</div>
					<div
						aria-label="Marketplace wallpaper categories"
						className="flex flex-wrap gap-1.5"
						role="group"
					>
						{marketplaceCategories.map((item) => (
							<button
								aria-pressed={marketplaceCategory === item}
								className={cn(
									"rounded-full border px-2.5 py-1 text-xs transition-colors",
									marketplaceCategory === item
										? "border-primary bg-primary text-primary-foreground"
										: "border-border bg-background hover:bg-muted"
								)}
								key={item}
								onClick={() => setMarketplaceCategory(item)}
								type="button"
							>
								{item}
							</button>
						))}
					</div>
				</div>
			) : null}

			{visible.length > 0 ? (
				<div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
					{visible.map((definition) => (
						<BackdropTile
							definition={definition}
							key={definition.id}
							onSelect={() =>
								update({
									backdrop: {
										id: definition.id,
										params:
											preference.backdrop?.id === definition.id
												? preference.backdrop.params
												: definition.origin === "marketplace"
													? definition.initialParams
													: {},
									},
									mode: "backdrop",
								})
							}
							selected={
								preference.mode === "backdrop" &&
								preference.backdrop?.id === definition.id
							}
						/>
					))}
				</div>
			) : (
				<p className="text-muted-foreground text-sm" role="status">
					No wallpapers match those filters.
				</p>
			)}
		</div>
	);
}
