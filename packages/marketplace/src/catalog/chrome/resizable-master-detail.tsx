// packages/marketplace/src/catalog/chrome/resizable-master-detail.tsx
//
// Moved verbatim from apps/desktop/src/components/store/ResizableMasterDetail.tsx
// so the shared catalog sections (apps/models/skills) are self-contained and
// render identically on desktop and web. The desktop path re-exports this.

import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import { useCallback, useState } from "react";

const LIST_PANEL_ID = "list";
const DETAIL_PANEL_ID = "detail";
const DEFAULT_LIST_SIZE = 28;
const DEFAULT_DETAIL_SIZE = 72;

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
			typeof (parsed as Layout)[LIST_PANEL_ID] === "number"
		) {
			return parsed as Layout;
		}
	} catch {
		// Corrupt or unavailable storage falls back to defaults.
	}
}

/**
 * Master-detail body with a draggable divider whose position is persisted to
 * localStorage under {@link storageKey}. Shared by the Store catalog sections so
 * the resize behavior and persistence stay identical.
 */
export default function ResizableMasterDetail({
	storageKey,
	listHeader,
	list,
	detail,
}: {
	storageKey: string;
	/** Fixed chrome (tabs + search) pinned to the top of the list column. */
	listHeader?: React.ReactNode;
	list: React.ReactNode;
	detail: React.ReactNode;
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
		<ResizablePanelGroup
			className="min-h-0 flex-1"
			defaultLayout={defaultLayout}
			onLayoutChanged={onLayoutChanged}
			orientation="horizontal"
		>
			<ResizablePanel
				defaultSize={DEFAULT_LIST_SIZE}
				id={LIST_PANEL_ID}
				minSize={18}
			>
				<div className="flex h-full min-h-0 flex-col">
					{listHeader}
					<div className="min-h-0 flex-1 overflow-hidden">{list}</div>
				</div>
			</ResizablePanel>
			{/* No visible divider — the floating detail card's edge separates the
			    panes. The handle stays draggable via its invisible hit area. */}
			<ResizableHandle className="w-2 bg-transparent" />
			<ResizablePanel
				defaultSize={DEFAULT_DETAIL_SIZE}
				id={DETAIL_PANEL_ID}
				minSize={40}
			>
				{/* Floating, rounded detail surface — mirrors the left app sidebar's
				    floating variant and the chat workspace's right panel. */}
				<div className="h-full p-2 pl-0">
					<div className="scroll-fade-effect-y flex size-full flex-col overflow-auto rounded-3xl border border-border/60 bg-sidebar shadow-sm dark:bg-sidebar/50">
						{detail}
					</div>
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
