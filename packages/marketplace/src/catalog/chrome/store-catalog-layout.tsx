// packages/marketplace/src/catalog/chrome/store-catalog-layout.tsx
//
// The shared body layout for every Store catalog section — the App Store shape:
//
//   ┌ Library-style toolbar: search + filter popover ┐
//   │ 2-column card grid (centered, max-width)       │  ← preview closed
//   └────────────────────────────────────────────────┘
//   ┌ list ── │ ── floating preview card ┐              ← preview open, wide window
//   └─────────┴───────────────────────────┘
//   list + <Dialog> preview                              ← preview open, narrow window
//
// Replaces ResizableMasterDetail for the catalog sections: the right preview only
// mounts when something is selected, and below a width threshold it becomes a
// dialog instead of a side pane. The toolbar mirrors the Library page's toolbar
// (compact search + filter button); the list is a 2-column card grid or a flat
// list when the Store shell's view preference says so.

import {
	Cancel01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { StoreSearchButton } from "@ryu/blocks/desktop/store.tsx";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

/** Below this content width the preview opens as a dialog, not a side pane. */
const NARROW_PX = 880;

const StoreViewModeContext = createContext<{ mode: ViewMode } | null>(null);

export function StoreViewModeProvider({
	children,
	mode,
}: {
	children: ReactNode;
	mode: ViewMode;
}) {
	return (
		<StoreViewModeContext.Provider value={{ mode }}>
			{children}
		</StoreViewModeContext.Provider>
	);
}

export function useStoreViewMode(): { mode: ViewMode } | null {
	return useContext(StoreViewModeContext);
}

/** Track a container's width via ResizeObserver (SSR-safe: 0 until measured). */
function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width;
			if (typeof w === "number") {
				setWidth(w);
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, width];
}

export default function StoreCatalogLayout({
	search,
	filter,
	list,
	detail,
	hasSelection,
	onCloseDetail,
	detailTitle = "Details",
	previewMode = "dialog",
}: {
	/** The giant search field pinned to the top. Omit for sections without search. */
	search?: {
		value: string;
		onChange: (value: string) => void;
		placeholder?: string;
	};
	/** Optional filter/sort controls, folded into a popover beside the search. */
	filter?: {
		panel: ReactNode;
		label?: string;
		icon?: IconSvgElement;
		/** Number of active filters, shown as a badge on the trigger. */
		activeCount?: number;
	};
	/** The 2-column card grid (see {@link StoreCardGrid}). */
	list: ReactNode;
	/** The right/dialog preview for the selected item. */
	detail: ReactNode;
	/** Whether an item is selected (drives whether the preview shows at all). */
	hasSelection: boolean;
	/** Close the preview (clears the selection); also the dialog's onClose. */
	onCloseDetail: () => void;
	/** Accessible dialog title used in the narrow-window fallback. */
	detailTitle?: string;
	/** How the preview is presented. "dialog" (default) always opens the preview
	 *  as a centered modal, so every tab reads the same. "auto" keeps the wide
	 *  side-pane / narrow-dialog split — used only where a persistent side pane
	 *  earns its space (Models, whose preview is a long per-file list). */
	previewMode?: "auto" | "dialog";
}) {
	const [ref, width] = useContainerWidth();
	// Before the first measure width is 0 — treat that as wide so the side pane is
	// the default and we never flash a dialog on mount.
	const narrow = width > 0 && width < NARROW_PX;
	// "dialog" mode forces the modal at every width; "auto" shows the side pane
	// when there is room and collapses to the dialog when narrow.
	const showSidePane = hasSelection && !narrow && previewMode === "auto";
	const showDialog = hasSelection && (narrow || previewMode === "dialog");

	return (
		<div className="flex h-full flex-col overflow-hidden" ref={ref}>
			<div className="flex min-h-0 flex-1 overflow-hidden">
				{/* Left region — the section's controls and its centered card grid share
				    one column at the same max-width, so they stay aligned in both
				    states; when the preview aside opens, the whole column narrows and
				    every row recenters together. The section TITLE is not here: the
				    Store's page chrome renders one title for every tab, carded or not. */}
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					{/* Card grid — the same centered max-width so selecting an item
					    never reflows it; the preview is a FIXED-width pane beside.
					    The section's own controls sit in one compact row above it:
					    a search BUTTON that expands in place plus whatever the
					    section declares (source, filters), so the row reads as
					    buttons rather than a full-width field that pushed them onto
					    a second line. Sticky, so it stays reachable while scrolling. */}
					<div className="scroll-fade min-h-0 flex-1 overflow-auto">
						{search || filter ? (
							<div className="sticky top-0 z-10 mx-auto flex w-full max-w-4xl items-center justify-end gap-1 bg-background px-4 pb-2">
								{search ? (
									<StoreSearchButton
										onChange={search.onChange}
										placeholder={search.placeholder ?? "Search…"}
										value={search.value}
									/>
								) : null}
								{filter ? (
									<Popover>
										<PopoverTrigger
											render={
												<Button className="gap-1.5" size="sm" variant="ghost">
													<HugeiconsIcon
														className="size-3.5"
														icon={filter.icon ?? SlidersHorizontalIcon}
													/>
													{filter.label ?? "Filters"}
													{filter.activeCount ? (
														<span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] text-background">
															{filter.activeCount}
														</span>
													) : null}
												</Button>
											}
										/>
										<PopoverContent
											align="end"
											className="w-[min(30rem,90vw)] p-0"
										>
											{filter.panel}
										</PopoverContent>
									</Popover>
								) : null}
							</div>
						) : null}
						<div className="mx-auto w-full max-w-4xl px-4 pb-24">{list}</div>
					</div>
				</div>

				{showSidePane ? (
					<aside className="w-[26rem] shrink-0 py-2 pr-2">
						<div className="scroll-fade relative flex size-full flex-col overflow-auto rounded-3xl border border-border/60 bg-sidebar shadow-sm dark:bg-sidebar/50">
							<button
								aria-label="Close preview"
								className="absolute top-3 right-3 z-10 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								onClick={onCloseDetail}
								type="button"
							>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							</button>
							{detail}
						</div>
					</aside>
				) : null}
			</div>

			{showDialog ? (
				<Dialog
					onOpenChange={(open) => {
						if (!open) {
							onCloseDetail();
						}
					}}
					open
				>
					{/* Wider than the default dialog: the preview carries a hero, a meta
					    strip, a tab bar and long-form README/API panels, and at the
					    primitive's default width every one of them wrapped early.
					    `min(80rem,94vw)` is the same figure `ListingDetailShell` documents
					    as its premise, so the shell's `lg:`-keyed two-column split and the
					    box it lives in agree; a small window still keeps a margin, and
					    there the dialog is the ONLY presentation.

					    THE `sm:` COPY IS LOAD-BEARING — do not drop it as a duplicate.
					    `DialogContent` ships `sm:max-w-md` in its base classes, and
					    `twMerge` only drops a class when the override shares its modifier
					    AND its group. An unprefixed `max-w-[…]` is a DIFFERENT group, so
					    `sm:max-w-md` survived into the markup, sorted after the
					    unprefixed utility, and won at equal specificity: every catalog
					    preview on this layout was clamped to 28rem on any window ≥640px
					    while `w-[…]` promised 64rem. Inside that 448px box the shell still
					    matched `lg:` (a VIEWPORT breakpoint) and handed the aside
					    `lg:w-72`, leaving the main column ~130px — the squashed preview.
					    Matching `sm:` here removes `sm:max-w-md` from the output entirely. */}
					<DialogContent className="max-h-[85vh] w-[min(80rem,94vw)] max-w-[min(80rem,94vw)] overflow-hidden p-0 sm:max-w-[min(80rem,94vw)]">
						<DialogTitle className="sr-only">{detailTitle}</DialogTitle>
						<div className="scroll-fade max-h-[85vh] overflow-auto">
							{detail}
						</div>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
}

/** Responsive card grid/list — mirrors the Library geometry
 * (`grid-cols-1 sm:grid-cols-2`) so the Store reads the same. Arbitrary
 * `repeat(auto-fill,…)` values are NOT used: Tailwind doesn't always emit them,
 * and a missing class silently collapses the grid to one full-width column. */
export function StoreCardGrid({
	children,
	view,
}: {
	children: ReactNode;
	view?: ViewMode;
}) {
	const context = useStoreViewMode();
	const activeView = view ?? context?.mode ?? "grid";
	if (activeView === "list") {
		return <div className="flex flex-col gap-1.5">{children}</div>;
	}
	return (
		<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
	);
}
