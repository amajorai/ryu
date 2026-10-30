import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MarketplaceWallpaperPickerDialog } from "@ryu/blocks/desktop/marketplace-wallpaper-picker.tsx";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	getMarketplaceBackdrops,
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import { usePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import { installWallpaper } from "@/src/lib/wallpaper-library.ts";

function spaceCoverPreferenceKey(spaceId: string): string {
	return `ryu.space-cover.v1:${encodeURIComponent(spaceId)}`;
}

export function SpaceWallpaperCover({
	spaceId,
	target,
}: {
	spaceId: string;
	target: ApiTarget;
}) {
	const pluginBackgrounds = usePluginBackgrounds();
	const wallpapers = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const [wallpaper, setWallpaper] = useState<RenderableBackdrop | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [storageError, setStorageError] = useState<string | null>(null);
	const preferenceKey = spaceCoverPreferenceKey(spaceId);

	useEffect(() => {
		let current = true;
		setLoading(true);
		setStorageError(null);
		void getPreference(target, preferenceKey)
			.then((raw) => {
				let parsed: RenderableBackdrop | null = null;
				if (raw) {
					try {
						parsed =
							resolveMarketplaceWallpaperSelection(JSON.parse(raw)) ?? null;
					} catch {
						parsed = null;
					}
				}
				if (current) {
					setWallpaper(parsed);
				}
			})
			.catch(() => {
				if (current) {
					setStorageError(
						"This Space cover could not be loaded from the node."
					);
				}
			})
			.finally(() => {
				if (current) {
					setLoading(false);
				}
			});
		return () => {
			current = false;
		};
	}, [preferenceKey, target]);

	const saveWallpaper = async (
		selectedWallpaper: RenderableBackdrop
	): Promise<boolean> => {
		setSaving(true);
		setStorageError(null);
		try {
			if (!installWallpaper(selectedWallpaper.id)) {
				setStorageError("This wallpaper could not be added to your Library.");
				return false;
			}
			const selection = toMarketplaceWallpaperSelection(selectedWallpaper);
			await setPreference(target, preferenceKey, JSON.stringify(selection));
			setWallpaper(selectedWallpaper);
			return true;
		} catch {
			setStorageError("This Space cover could not be saved to the node.");
			return false;
		} finally {
			setSaving(false);
		}
	};

	const clearWallpaper = async () => {
		setSaving(true);
		setStorageError(null);
		try {
			await setPreference(target, preferenceKey, "null");
			setWallpaper(null);
		} catch {
			setStorageError("This Space cover could not be saved to the node.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<section aria-label="Space cover" className="space-y-2">
			<div
				className="group/cover relative isolate h-44 overflow-hidden rounded-xl bg-muted sm:h-52"
				data-testid="space-marketplace-cover"
			>
				{wallpaper ? (
					<>
						<Backdrop
							className="absolute inset-0"
							definition={wallpaper}
							live={false}
							params={wallpaper.initialParams}
						/>
						{/* One bottom scrim keeps the label legible over any cover. */}
						<div className="absolute inset-0 bg-gradient-to-t from-background/75 via-background/10 to-transparent" />
					</>
				) : null}
				{/* With a cover set, its actions wait for hover; an empty cover's only
				    job is to be chosen, so "Choose cover" stays visible. An open menu
				    keeps its trigger shown while the pointer is in the popup. */}
				<div
					className={cn(
						"absolute top-3 right-3 flex items-center gap-1 transition-opacity duration-150 focus-within:opacity-100 group-hover/cover:opacity-100 group-hover/cover:duration-0 has-[[data-popup-open]]:opacity-100",
						wallpaper ? "opacity-0" : "opacity-100"
					)}
				>
					<Button
						disabled={saving || loading}
						onClick={() => setPickerOpen(true)}
						size="sm"
						variant="secondary"
					>
						{wallpaper ? "Change cover" : "Choose cover"}
					</Button>
					{wallpaper ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="More cover options"
										disabled={saving || loading}
										size="icon-sm"
										variant="secondary"
									>
										<HugeiconsIcon
											className="size-4"
											icon={MoreHorizontalIcon}
										/>
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => void clearWallpaper()}>
									Remove cover
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
				<div className="absolute inset-x-4 bottom-4 text-foreground">
					<p className="font-medium text-sm">
						{wallpaper?.label ?? "Space cover"}
					</p>
					{loading ? (
						<p className="text-detail text-muted-foreground">
							Loading cover from this node…
						</p>
					) : null}
				</div>
			</div>
			{storageError ? <ErrorLine message={storageError} /> : null}
			<MarketplaceWallpaperPickerDialog
				onOpenChange={setPickerOpen}
				onSelect={saveWallpaper}
				open={pickerOpen}
				selectedId={wallpaper?.id}
				title="Choose a Space cover"
				wallpapers={wallpapers}
			/>
		</section>
	);
}
