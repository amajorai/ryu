import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import type { RenderableBackdrop } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo, useState } from "react";
import styles from "./marketplace-wallpaper-picker.module.css";

const ALL_CATEGORIES = "All categories";

function WallpaperOption({
	busy,
	onSelect,
	selected,
	wallpaper,
}: {
	busy: boolean;
	onSelect: (wallpaper: RenderableBackdrop) => void;
	selected: boolean;
	wallpaper: RenderableBackdrop;
}) {
	return (
		<button
			aria-pressed={selected}
			className={cn(
				"flex min-w-0 flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
				selected
					? "border-primary bg-primary/5"
					: "border-border hover:bg-muted/60",
				busy && "cursor-wait opacity-60"
			)}
			data-testid={`banner-wallpaper-${wallpaper.id}`}
			disabled={busy}
			onClick={() => onSelect(wallpaper)}
			type="button"
		>
			<span className="relative block aspect-[16/9] overflow-hidden rounded-lg bg-muted">
				<Backdrop
					definition={wallpaper}
					params={wallpaper.initialParams}
					posterOnly
				/>
			</span>
			<span className="flex min-w-0 items-start justify-between gap-2">
				<span className="truncate font-medium text-sm">{wallpaper.label}</span>
				<span className="shrink-0 text-muted-foreground text-xs">
					{wallpaper.category}
				</span>
			</span>
			<span className="truncate text-muted-foreground text-xs">
				{wallpaper.description}
			</span>
		</button>
	);
}

/** A bounded, searchable selector shared by Space and profile banner controls. */
export function MarketplaceWallpaperPickerDialog({
	onOpenChange,
	onSelect,
	open,
	selectedId,
	title = "Choose a wallpaper",
	wallpapers,
}: {
	onOpenChange: (open: boolean) => void;
	/** Return false to keep the picker open after a failed persistent write. */
	onSelect: (wallpaper: RenderableBackdrop) => boolean | Promise<boolean>;
	open: boolean;
	selectedId?: string | null;
	title?: string;
	wallpapers: readonly RenderableBackdrop[];
}) {
	const tl = useLiteralMessages();
	const [category, setCategory] = useState(ALL_CATEGORIES);
	const [query, setQuery] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const categories = useMemo(
		() => [
			ALL_CATEGORIES,
			...new Set(wallpapers.map((wallpaper) => wallpaper.category)),
		],
		[wallpapers]
	);
	const normalizedQuery = query.trim().toLowerCase();
	const visible = useMemo(
		() =>
			wallpapers.filter((wallpaper) => {
				const matchesCategory =
					category === ALL_CATEGORIES || wallpaper.category === category;
				const searchable =
					`${wallpaper.label} ${wallpaper.description} ${wallpaper.attribution ?? ""}`.toLowerCase();
				return (
					matchesCategory &&
					(!normalizedQuery || searchable.includes(normalizedQuery))
				);
			}),
		[category, normalizedQuery, wallpapers]
	);

	const selectWallpaper = async (wallpaper: RenderableBackdrop) => {
		setBusyId(wallpaper.id);
		setSelectionError(null);
		try {
			const result = await onSelect(wallpaper);
			if (result === false) {
				setSelectionError("The wallpaper could not be saved. Try again.");
			} else {
				onOpenChange(false);
			}
		} catch {
			setSelectionError("The wallpaper could not be saved. Try again.");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				appearance="project-settings"
				className="max-h-[min(88vh,56rem)]"
			>
				<header
					className={cn(
						"flex shrink-0 flex-col gap-1.5 text-left",
						styles.header
					)}
					data-slot="dialog-header"
				>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						Choose a Marketplace wallpaper to add to your Library and paint with
						this surface's built-in adapter.
					</DialogDescription>
				</header>
				<div className="shrink-0 space-y-3 border-b px-5 py-3">
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative min-w-48 flex-1 sm:max-w-sm">
							<HugeiconsIcon
								className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search wallpapers"
								leadingAdornment="compact"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search wallpapers"
								value={query}
							/>
						</div>
						<p aria-live="polite" className="text-muted-foreground text-xs">
							{tl("{visibleCount} of {totalCount} wallpapers", {
								totalCount: String(wallpapers.length),
								visibleCount: String(visible.length),
							})}
						</p>
					</div>
					<div
						aria-label="Wallpaper categories"
						className="flex flex-wrap gap-1.5"
						role="group"
					>
						{categories.map((item) => (
							<Button
								aria-pressed={category === item}
								key={item}
								onClick={() => setCategory(item)}
								size="sm"
								variant={category === item ? "secondary" : "ghost"}
							>
								{item}
							</Button>
						))}
					</div>
					{selectionError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{selectionError}
						</p>
					) : null}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-5">
					{visible.length > 0 ? (
						<div className="grid grid-cols-2 gap-3 md:grid-cols-3">
							{visible.map((wallpaper) => (
								<WallpaperOption
									busy={busyId !== null}
									key={wallpaper.id}
									onSelect={(selected) => {
										void selectWallpaper(selected);
									}}
									selected={wallpaper.id === selectedId}
									wallpaper={wallpaper}
								/>
							))}
						</div>
					) : (
						<div className="flex min-h-48 items-center justify-center p-6 text-center">
							<div className="max-w-sm space-y-2">
								<p className="font-medium">No wallpapers match those filters</p>
								<p className="text-muted-foreground text-sm">
									Try another search or category.
								</p>
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
