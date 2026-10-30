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
// pane, and the divider is still draggable either way. 24% of the 880px
// settings frame (~210px) keeps "Keyboard Shortcuts" and "Sessions & devices"
// whole now that the nav column is flush with the dialog edge.
const DEFAULT_SIDEBAR_SIZE = 24;
const DEFAULT_CONTENT_SIZE = 76;
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
	 * `dialog` (default): a flush `bg-sidebar` nav column beside a flush
	 * `bg-background` content pane, split by a divider that shows on hover, in
	 * the desktop Settings and Gateway dialogs.
	 * `page`: a flush nav column beside a flush content pane, split by a
	 * hairline, for a settings page that already sits on the app's background
	 * (the web settings pages). It is one CSS-responsive tree with a
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
				className="!min-h-0 h-full flex-col overflow-hidden rounded-none"
			>
				<Sidebar
					className="max-h-[38%] min-h-0 w-full shrink-0 p-2 pb-0"
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
				<ContentPane
					contentScrollable={contentScrollable}
					contentScrollRef={contentScrollRef}
				>
					{content}
				</ContentPane>
			</SidebarProvider>
		);
	}

	return (
		<SidebarProvider
			appearance="settings-frame"
			className="!min-h-0 h-full overflow-hidden rounded-none"
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
					{/* Flush with the dialog edge: the nav is set off from the pane by
					    tone alone (bg-sidebar against bg-background), no card or gap. */}
					<Sidebar className="h-full w-full py-2" collapsible="none">
						<SidebarContent className="overflow-x-hidden" spacing="compact">
							{sidebar}
						</SidebarContent>
					</Sidebar>
				</ResizablePanel>
				{/* Invisible until pointed at: the tone change already marks the edge,
				    so the draggable divider only shows a hairline on hover or drag. */}
				<ResizableHandle
					appearance="transparent"
					className="transition-colors duration-(--duration-fast) hover:bg-border data-[separator=active]:bg-border"
				/>
				<ResizablePanel
					className="min-w-0 overflow-hidden"
					defaultSize={DEFAULT_CONTENT_SIZE}
					id={CONTENT_PANEL_ID}
					minSize={CONTENT_MIN_SIZE}
				>
					<ContentPane
						contentScrollable={contentScrollable}
						contentScrollRef={contentScrollRef}
					>
						{content}
					</ContentPane>
				</ResizablePanel>
			</ResizablePanelGroup>
		</SidebarProvider>
	);
}

/** The flush content pane of the dialog frame: the page tone, one scroller. */
function ContentPane({
	children,
	contentScrollable,
	contentScrollRef,
}: {
	children: React.ReactNode;
	contentScrollable: boolean;
	contentScrollRef?: React.Ref<HTMLDivElement>;
}) {
	return (
		<div className="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-background">
			<div
				className={cn(
					"h-full w-full overflow-x-hidden",
					contentScrollable
						? "scroll-fade overflow-y-auto [scrollbar-gutter:stable]"
						: "overflow-y-hidden"
				)}
				ref={contentScrollRef}
			>
				{children}
			</div>
		</div>
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
			<div className="max-h-[38%] min-h-0 shrink-0 overflow-hidden border-b md:h-full md:max-h-none md:w-[clamp(15rem,22%,20rem)] md:border-r md:border-b-0">
				<Sidebar
					appearance="settings-navigation"
					className="h-full w-full bg-transparent py-2"
					collapsible="none"
				>
					<SidebarContent className="overflow-x-hidden" spacing="compact">
						{sidebar}
					</SidebarContent>
				</Sidebar>
			</div>
			{/* Flush like the desktop Settings window's content pane: no inset,
			    rounding or second surface. */}
			<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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
