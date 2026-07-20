import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable";
import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@ryu/ui/components/sidebar";
import { useCallback, useState } from "react";

const SIDEBAR_PANEL_ID = "sidebar";
const CONTENT_PANEL_ID = "content";
const DEFAULT_SIDEBAR_SIZE = 15;
const DEFAULT_CONTENT_SIZE = 85;
// Keep the sidebar usable but bounded: the content panel's minSize caps how
// wide the sidebar can grow (100 - CONTENT_MIN_SIZE).
const SIDEBAR_MIN_SIZE = 10;
const CONTENT_MIN_SIZE = 55;

type Layout = Record<string, number>;

function loadLayout(storageKey: string): Layout | undefined {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return;
		}
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as Layout)[SIDEBAR_PANEL_ID] === "number"
		) {
			return parsed as Layout;
		}
	} catch {
		// Corrupt or unavailable storage falls back to defaults.
	}
}

/**
 * Settings-style dialog body with a draggable divider between the navigation
 * sidebar and the content pane. The divider position is persisted to
 * localStorage under {@link storageKey}. Shared by the app Settings and Gateway
 * settings dialogs so the resize behavior and persistence stay identical.
 */
export default function ResizableSettingsLayout({
	storageKey,
	sidebar,
	content,
}: {
	storageKey: string;
	sidebar: React.ReactNode;
	content: React.ReactNode;
}) {
	const [defaultLayout] = useState<Layout | undefined>(() =>
		loadLayout(storageKey)
	);

	const onLayoutChanged = useCallback(
		(layout: Layout) => {
			try {
				localStorage.setItem(storageKey, JSON.stringify(layout));
			} catch {
				// Persisting the layout is best-effort; ignore storage failures.
			}
		},
		[storageKey]
	);

	return (
		<SidebarProvider className="!min-h-0 h-full overflow-hidden rounded-lg bg-sidebar">
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
						<Sidebar className="h-full w-full rounded-xl" collapsible="none">
							<SidebarContent className="scroll-fade-effect-y overflow-x-hidden pt-2 pb-12">
								{sidebar}
							</SidebarContent>
						</Sidebar>
					</div>
				</ResizablePanel>
				{/* Thin transparent handle: keeps the seamless look of the floating
				    cards while exposing a draggable hit area between the panes. */}
				<ResizableHandle className="w-1 bg-transparent" />
				<ResizablePanel
					className="min-w-0 overflow-hidden"
					defaultSize={DEFAULT_CONTENT_SIZE}
					id={CONTENT_PANEL_ID}
					minSize={CONTENT_MIN_SIZE}
				>
					<div className="h-full min-w-0 overflow-hidden p-2 pl-0">
						<div className="relative h-full min-w-0 overflow-hidden rounded-xl bg-background shadow-sm">
							<div className="scroll-fade-effect-y h-full w-full overflow-y-auto overflow-x-hidden">
								{content}
							</div>
						</div>
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
		</SidebarProvider>
	);
}
