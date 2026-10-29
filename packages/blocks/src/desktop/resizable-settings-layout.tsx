import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@ryu/ui/components/sidebar.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useState } from "react";
import { z } from "zod";

const SIDEBAR_PANEL_ID = "sidebar";
const CONTENT_PANEL_ID = "content";
// 15% of an 85vw dialog left the nav column narrow enough that ordinary section
// labels ("Appearance", "Notifications", "Agent defaults") wrapped or truncated,
// which is what made both settings dialogs read as cramped. 22% fits the longest
// shipped label on a laptop screen without taking real space from the content
// pane, and the divider is still draggable either way.
const DEFAULT_SIDEBAR_SIZE = 22;
const DEFAULT_CONTENT_SIZE = 78;
// Keep the sidebar usable but bounded: the content panel's minSize caps how
// wide the sidebar can grow (100 - CONTENT_MIN_SIZE).
const SIDEBAR_MIN_SIZE = 16;
const CONTENT_MIN_SIZE = 55;

const layoutSchema = z
	.record(z.string(), z.number())
	.refine((layout) => layout.sidebar !== undefined);
type Layout = z.infer<typeof layoutSchema>;

function loadLayout(storageKey: string): Layout | undefined {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return;
		}
		return layoutSchema.parse(JSON.parse(raw));
	} catch {
		// Corrupt or unavailable storage falls back to defaults.
	}
}

/**
 * Settings-style body with a draggable divider between the navigation sidebar
 * and the content pane. With a {@link storageKey} the divider position is
 * persisted to localStorage. Shared by the desktop app Settings and Gateway
 * settings dialogs and the web settings pages so the frame, resize behavior,
 * and persistence stay identical. A server-rendered page omits `storageKey`:
 * a stored split read during the first client render would not match the
 * server's HTML.
 */
export default function ResizableSettingsLayout({
	storageKey,
	sidebar,
	content,
	contentScrollable = true,
	contentScrollRef,
	appearance = "dialog",
}: {
	contentScrollable?: boolean;
	/** Ref to the content pane's scroller (the element that scrolls). */
	contentScrollRef?: React.Ref<HTMLDivElement>;
	/**
	 * `dialog` (default): a rounded sidebar frame beside a raised content card,
	 * with a draggable divider, in the desktop Settings and Gateway dialogs.
	 * `page`: a floating rounded muted sidebar card, inset from the edges,
	 * beside plain content, for a settings page that already sits on the app's
	 * background (the web settings pages). It is one CSS-responsive tree with a
	 * fixed-width sidebar, so crossing the phone breakpoint never remounts the
	 * open section (its dialogs and unsaved edits survive a rotation) and the
	 * server's HTML matches the first client render.
	 */
	appearance?: "dialog" | "page";
	storageKey?: string;
	sidebar: React.ReactNode;
	content: React.ReactNode;
}) {
	const [defaultLayout] = useState<Layout | undefined>(() =>
		storageKey ? loadLayout(storageKey) : undefined
	);

	const onLayoutChanged = useCallback(
		(layout: Layout) => {
			if (!storageKey) {
				return;
			}
			try {
				localStorage.setItem(storageKey, JSON.stringify(layout));
			} catch {
				// Persisting the layout is best-effort; ignore storage failures.
			}
		},
		[storageKey]
	);

	// Two side-by-side columns don't fit a phone: the content pane's 55% minimum
	// would leave the nav under 170px. Stack instead — nav on top in its own
	// scroller, content filling the rest — and skip the drag divider, which has
	// no touch affordance anyway. The persisted horizontal split is untouched.
	const isMobile = useIsMobile();
	if (appearance === "page") {
		return (
			<PageSettingsLayout
				content={content}
				contentScrollable={contentScrollable}
				contentScrollRef={contentScrollRef}
				sidebar={sidebar}
			/>
		);
	}
	if (isMobile) {
		return (
			<SidebarProvider
				appearance="settings-frame"
				className="!min-h-0 h-full flex-col overflow-hidden"
			>
				<div className="max-h-[38%] min-h-0 shrink-0 overflow-hidden p-2 pb-0">
					<Sidebar
						appearance="settings-navigation"
						className="h-full w-full"
						collapsible="none"
					>
						{/* Stacked, the nav starts at the dialog's top edge — which is
						    also where the close button sits. Start the list below it. */}
						<SidebarContent
							className="overflow-x-hidden"
							spacing="settings-mobile"
						>
							{sidebar}
						</SidebarContent>
					</Sidebar>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden p-2">
					<div className="grouped-pane relative h-full min-w-0 overflow-hidden rounded-xl shadow-sm">
						<div
							className={cn(
								"h-full w-full overflow-x-hidden",
								contentScrollable
									? "scroll-fade overflow-y-auto"
									: "overflow-y-hidden"
							)}
							ref={contentScrollRef}
						>
							{content}
						</div>
					</div>
				</div>
			</SidebarProvider>
		);
	}

	return (
		<SidebarProvider
			appearance="settings-frame"
			className="!min-h-0 h-full overflow-hidden"
		>
			<ResizablePanelGroup
				className="h-full w-full"
				defaultLayout={defaultLayout}
				onLayoutChanged={onLayoutChanged}
				orientation="horizontal"
			>
				<ResizablePanel
					className="min-w-0 overflow-hidden"
					defaultSize={DEFAULT_SIDEBAR_SIZE}
					id={SIDEBAR_PANEL_ID}
					minSize={SIDEBAR_MIN_SIZE}
				>
					<div className="h-full min-w-0 overflow-hidden p-2 pr-0">
						<Sidebar
							appearance="settings-navigation"
							className="h-full w-full"
							collapsible="none"
						>
							<SidebarContent className="overflow-x-hidden" spacing="compact">
								{sidebar}
							</SidebarContent>
						</Sidebar>
					</div>
				</ResizablePanel>
				{/* Thin transparent handle: keeps the seamless look of the floating
				    cards while exposing a draggable hit area between the panes. */}
				<ResizableHandle className="w-1" />
				<ResizablePanel
					className="min-w-0 overflow-hidden"
					defaultSize={DEFAULT_CONTENT_SIZE}
					id={CONTENT_PANEL_ID}
					minSize={CONTENT_MIN_SIZE}
				>
					<div className="h-full min-w-0 overflow-hidden p-2 pl-0">
						<div className="grouped-pane relative h-full min-w-0 overflow-hidden rounded-xl shadow-sm">
							<div
								className={cn(
									"h-full w-full overflow-x-hidden",
									contentScrollable
										? "scroll-fade overflow-y-auto"
										: "overflow-y-hidden"
								)}
								ref={contentScrollRef}
							>
								{content}
							</div>
						</div>
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
		</SidebarProvider>
	);
}

/** The web settings page frame; see `appearance="page"` above. */
function PageSettingsLayout({
	content,
	contentScrollable,
	contentScrollRef,
	sidebar,
}: {
	content: React.ReactNode;
	contentScrollable: boolean;
	contentScrollRef?: React.Ref<HTMLDivElement>;
	sidebar: React.ReactNode;
}) {
	return (
		<SidebarProvider
			appearance="settings-frame"
			className="!min-h-0 h-full flex-col overflow-hidden rounded-none bg-transparent md:flex-row"
		>
			<div className="max-h-[38%] min-h-0 shrink-0 overflow-hidden p-3 pb-0 md:h-full md:max-h-none md:w-[clamp(15rem,22%,20rem)] md:pr-0 md:pb-3">
				<Sidebar
					appearance="settings-navigation"
					className="h-full w-full rounded-xl bg-muted/50"
					collapsible="none"
				>
					<SidebarContent className="overflow-x-hidden" spacing="compact">
						{sidebar}
					</SidebarContent>
				</Sidebar>
			</div>
			{/* The content is a grouped pane, inset like the sidebar card, so web
			    settings read as the desktop Settings window does: grey grouped
			    background with white settings cards in light mode. */}
			<div className="grouped-pane m-3 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl md:ml-2">
				<div
					className={cn(
						"h-full w-full overflow-x-hidden",
						contentScrollable
							? "scroll-fade overflow-y-auto"
							: "overflow-y-hidden"
					)}
					ref={contentScrollRef}
				>
					{content}
				</div>
			</div>
		</SidebarProvider>
	);
}
