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
// (compact search + filter button); the list is a 2-column card grid.

import {
	Cancel01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LibraryToolbar } from "@ryu/blocks/desktop/library.tsx";
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

/** Section header (title/subtitle) rendered inside the catalog's centered left
 *  column so it tracks the card grid — including when the preview aside opens and
 *  the grid recenters. The Store shell supplies it per section. */
const StoreCatalogHeaderContext = createContext<ReactNode>(null);

export function StoreCatalogHeaderProvider({
	header,
	children,
}: {
	header: ReactNode;
	children: ReactNode;
}) {
	return (
		<StoreCatalogHeaderContext.Provider value={header}>
			{children}
		</StoreCatalogHeaderContext.Provider>
	);
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
	const header = useContext(StoreCatalogHeaderContext);
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
				{/* Left region — header, toolbar and the centered card grid share one
				    column at the same max-width, so they stay aligned in both states;
				    when the preview aside opens, the whole column narrows and every
				    row recenters together. */}
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					{header ? (
						<div className="mx-auto w-full max-w-4xl shrink-0">{header}</div>
					) : null}

					{search ? (
						<div className="mx-auto w-full max-w-4xl shrink-0">
							<LibraryToolbar
								filterSlot={
									filter ? (
										<Popover>
											<PopoverTrigger
												render={
													<Button
														className="gap-1.5"
														size="sm"
														variant={
															filter.activeCount ? "secondary" : "outline"
														}
													>
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
									) : null
								}
								onQueryChange={search.onChange}
								query={search.value}
								searchPlaceholder={search.placeholder ?? "Search…"}
							/>
						</div>
					) : null}

					{/* Card grid — the same centered max-width so selecting an item
					    never reflows it; the preview is a FIXED-width pane beside. */}
					<div className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto px-4 pb-24">
						<div className="mx-auto w-full max-w-4xl px-4">{list}</div>
					</div>
				</div>

				{showSidePane ? (
					<aside className="w-[26rem] shrink-0 py-2 pr-2">
						<div className="scroll-fade-effect-y relative flex size-full flex-col overflow-auto rounded-3xl border border-border/60 bg-sidebar shadow-sm dark:bg-sidebar/50">
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
					<DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden p-0">
						<DialogTitle className="sr-only">{detailTitle}</DialogTitle>
						<div className="scroll-fade-effect-y max-h-[85vh] overflow-auto">
							{detail}
						</div>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
}

/** Responsive card grid — mirrors the Library grid (`grid-cols-1 sm:grid-cols-2`)
 *  so the Store reads the same. Arbitrary `repeat(auto-fill,…)` values are NOT
 *  used: Tailwind doesn't always emit them, and a missing class silently
 *  collapses the grid to one full-width column. */
export function StoreCardGrid({ children }: { children: ReactNode }) {
	return (
		<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
	);
}
