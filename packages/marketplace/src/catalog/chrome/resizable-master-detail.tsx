import {
	isNativeNumber,
	isNativeObjectLike,
} from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/chrome/resizable-master-detail.tsx
//
// Formerly apps/desktop/src/components/store/ResizableMasterDetail.tsx (since removed)
// so the shared catalog sections (apps/models/skills) are self-contained and
// render identically on desktop and web.

import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import { type ComponentProps, useCallback, useState } from "react";
import { z } from "zod";

const LIST_PANEL_ID = "list";
const DETAIL_PANEL_ID = "detail";
const DEFAULT_LIST_SIZE = 28;
const DEFAULT_DETAIL_SIZE = 72;

type Layout = NonNullable<
	ComponentProps<typeof ResizablePanelGroup>["defaultLayout"]
>;

// localStorage is decoded with native JSON.parse below. A stored layout is the
// complete panel-id-to-number map owned by the installed panel group. Retain
// that decoded object, including every own key, after validating all its cells.
const storedLayoutSchema = z.custom<Layout>((value) => {
	const object = z.instanceof(Object).safeParse(value);
	return (
		object.success &&
		isNativeObjectLike(object.data) &&
		!Array.isArray(object.data) &&
		Object.values(object.data).every(isNativeNumber)
	);
});

function loadLayout(storageKey: string): Layout | undefined {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return;
		}
		const parsed = storedLayoutSchema.safeParse(JSON.parse(raw));
		if (parsed.success && isNativeNumber(parsed.data[LIST_PANEL_ID])) {
			return parsed.data;
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
			<ResizableHandle appearance="transparent" className="w-2" />
			<ResizablePanel
				defaultSize={DEFAULT_DETAIL_SIZE}
				id={DETAIL_PANEL_ID}
				minSize={40}
			>
				{/* Floating, rounded detail surface — mirrors the left app sidebar's
				    floating variant and the chat workspace's right panel. */}
				<div className="h-full p-2 pl-0">
					<div className="scroll-fade flex size-full flex-col overflow-auto rounded-3xl border border-border/60 bg-sidebar shadow-sm dark:bg-sidebar/50">
						{detail}
					</div>
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
