import type { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import {
	Children,
	type DragEvent,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { z } from "zod";
import { observeNativeOptionalProperty } from "../lib/native-optional-property.mjs";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import type { TabsValue } from "./tabs-root.tsx";

// Internal clone attributes are exact authored data-* slots; the complete native
// Tab props and BaseUI event handlers remain the installed SDK owner.
interface ManagedTabAttributes {
	"data-tabs-dragging"?: string | undefined;
	"data-tabs-drop-target"?: string | undefined;
	"data-tabs-managed-key"?: string | undefined;
	"data-tabs-managed-trigger"?: string | undefined;
	"data-tabs-promoted"?: string | undefined;
}

interface TabItem {
	element: ReactElement<TabsPrimitive.Tab.Props & ManagedTabAttributes>;
	key: string;
	label: string;
	value: TabsValue;
}

const TABS_STORAGE_PREFIX = "ryu.tabs.layout.v1";
const TABS_DRAG_MIME = "application/x-ryu-tabs-layout";

function tabValueKey(value: TabsValue) {
	if (value === null) {
		return "null";
	}
	if (isNativeText(value)) {
		return `string:${value}`;
	}
	if (isNativeNumber(value)) {
		return `number:${String(value)}`;
	}
	if (isNativeBoolean(value)) {
		return `boolean:${String(value)}`;
	}
	try {
		return `json:${JSON.stringify(value)}`;
	} catch {
		return `value:${String(value)}`;
	}
}

function textFromNode(node: ReactNode): string {
	if (isNativeText(node) || isNativeNumber(node)) {
		return String(node);
	}
	if (Array.isArray(node)) {
		return node.map(textFromNode).join(" ");
	}
	if (isValidElement<{ children?: ReactNode }>(node)) {
		return textFromNode(node.props.children);
	}
	return "";
}

function getTabItems(children: ReactNode) {
	const items: TabItem[] = [];
	const staticChildren: ReactNode[] = [];
	const seenKeys = new Set<string>();

	for (const child of Children.toArray(children)) {
		if (!isValidElement<TabsPrimitive.Tab.Props>(child)) {
			staticChildren.push(child);
			continue;
		}
		const props = child.props;
		if (!("value" in props) || props.value === undefined) {
			staticChildren.push(child);
			continue;
		}
		const baseKey = tabValueKey(props.value);
		const key = seenKeys.has(baseKey) ? `${baseKey}:${items.length}` : baseKey;
		seenKeys.add(baseKey);
		const label =
			(isNativeText(props["aria-label"]) && props["aria-label"]) ||
			(isNativeText(props.title) && props.title) ||
			textFromNode(props.children).replace(/\s+/g, " ").trim() ||
			String(props.value);
		items.push({
			element: child,
			key,
			label,
			value: props.value,
		});
	}

	return { items, staticChildren };
}

function normalizeOrder(order: string[], keys: string[]) {
	const keySet = new Set(keys);
	const normalized = order.filter((key) => keySet.has(key));
	for (const key of keys) {
		if (!normalized.includes(key)) {
			normalized.push(key);
		}
	}
	return normalized;
}

function reorderKeys(
	order: string[],
	draggingKey: string,
	targetKey: string,
	before: boolean
) {
	if (draggingKey === targetKey) {
		return order;
	}
	const withoutDragging = order.filter((key) => key !== draggingKey);
	const targetIndex = withoutDragging.indexOf(targetKey);
	if (targetIndex < 0) {
		return order;
	}
	const insertAt = before ? targetIndex : targetIndex + 1;
	return [
		...withoutDragging.slice(0, insertAt),
		draggingKey,
		...withoutDragging.slice(insertAt),
	];
}

const persistedTabsLayoutSchema = z.preprocess((data) => {
	if (data === null || data === undefined) {
		return null;
	}
	const hidden = observeNativeOptionalProperty(data, "hidden");
	const order = observeNativeOptionalProperty(data, "order");
	return {
		hidden: Array.isArray(hidden) ? hidden.filter(isNativeText) : [],
		order: Array.isArray(order) ? order.filter(isNativeText) : [],
	};
}, z
	.object({ hidden: z.array(z.string()), order: z.array(z.string()) })
	.nullable());

function readPersistedLayout(storageKey: string) {
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) {
			return null;
		}
		return persistedTabsLayoutSchema.parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

function writePersistedLayout(
	storageKey: string,
	order: string[],
	hidden: string[]
) {
	try {
		window.localStorage.setItem(
			storageKey,
			JSON.stringify({ hidden, order, version: 1 })
		);
	} catch {
		// Storage can be unavailable in private browsing or a locked-down WebView.
	}
}

function getDefaultStorageKey(
	id: string | undefined,
	variant: string | undefined
) {
	const locationKey =
		globalThis.window === undefined ? "server" : window.location.pathname;
	return `${TABS_STORAGE_PREFIX}:${locationKey}:${id ?? variant ?? "default"}`;
}

/**
 * Drop target for a drag over `hoveredKey`. When the dragged tab belongs to
 * this list its neighbours have slid aside, so the target is the resting slot
 * under the pointer (landing before it when moving back, after it when moving
 * forward); otherwise it is the hovered tab's nearer half.
 */
function resolveTabsDrop(
	drag: TabsDragController,
	shift: ReorderShift,
	order: string[],
	hoveredKey: string,
	event: DragEvent<HTMLElement>,
	axis: "x" | "y"
): { before: boolean; key: string } {
	const source = drag.draggingKey;
	if (source && shift.tracks(source)) {
		const key = shift.resolveOver(hoveredKey, event.clientX, event.clientY);
		return { before: order.indexOf(key) < order.indexOf(source), key };
	}
	const rect = event.currentTarget.getBoundingClientRect();
	return {
		before:
			axis === "x"
				? event.clientX < rect.left + rect.width / 2
				: event.clientY < rect.top + rect.height / 2,
		key: hoveredKey,
	};
}

interface TabsDragController {
	draggingKey: string | null;
	dropTarget: { before: boolean; key: string } | null;
	/** Slides the layout menu's rows apart to preview the drop. */
	menuShift: ReorderShift;
	onDragEnd: () => void;
	onDragOver: (key: string, before: boolean, element?: HTMLElement) => void;
	onDragStart: (key: string, event: DragEvent<HTMLElement>) => void;
	onDrop: (key: string, before: boolean, sourceKey?: string) => void;
	/** Slides the tab triggers apart to preview the drop. */
	shift: ReorderShift;
}

interface VisibleTabsLayoutOptions {
	activeKey: string | null;
	hiddenKeys: Set<string>;
	order: string[];
	orientation: "horizontal" | "vertical";
	reserveMore: boolean;
	widths: Map<string, number>;
}

interface VisibleTabsResolution {
	keys: string[];
	promotedKey: string | null;
}

/**
 * Layout snaps each box to sub-pixel units, so a row that is exactly as wide
 * as its tabs can measure a fraction of a pixel narrower than their sum.
 */
const TAB_FIT_SUBPIXEL_TOLERANCE_PX = 0.5;

/**
 * Size an element along the row axis in layout pixels, before CSS transforms.
 * A bounding rect is scaled by any ancestor transform (a dialog's zoom-in), and
 * the first fit often runs mid-animation, while gap and padding come from
 * computed style unscaled; mixing the two misfits rows that fill their width
 * exactly. A laid-out border-box element's computed size is its fractional
 * untransformed border box, so prefer it and fall back to the rect elsewhere.
 */
function measureTabLayoutSize(element: HTMLElement, isVertical: boolean) {
	const style = getComputedStyle(element);
	if (style.boxSizing === "border-box") {
		const size = Number.parseFloat(isVertical ? style.height : style.width);
		if (Number.isFinite(size) && size > 0) {
			return size;
		}
	}
	const rect = element.getBoundingClientRect();
	return isVertical ? rect.height : rect.width;
}

function resolveVisibleTabKeys(
	list: HTMLDivElement,
	{
		activeKey,
		hiddenKeys,
		orientation,
		order,
		reserveMore,
		widths,
	}: VisibleTabsLayoutOptions
): VisibleTabsResolution {
	const candidates = order.filter((key) => !hiddenKeys.has(key));
	if (candidates.length === 0) {
		return {
			keys: activeKey !== null && order.includes(activeKey) ? [activeKey] : [],
			promotedKey:
				activeKey !== null && order.includes(activeKey) ? activeKey : null,
		};
	}
	const firstCandidate = candidates[0];
	if (firstCandidate === undefined) {
		return { keys: [], promotedKey: null };
	}

	const moreTrigger = list.querySelector<HTMLElement>(
		"[data-tabs-more-trigger]"
	);
	const computedStyle = getComputedStyle(list);
	const isVertical = orientation === "vertical";
	const parsedGap = Number.parseFloat(
		isVertical ? computedStyle.rowGap : computedStyle.columnGap
	);
	const gap = Number.isFinite(parsedGap) ? parsedGap : 0;
	const parsedPaddingStart = Number.parseFloat(
		isVertical ? computedStyle.paddingTop : computedStyle.paddingLeft
	);
	const parsedPaddingEnd = Number.parseFloat(
		isVertical ? computedStyle.paddingBottom : computedStyle.paddingRight
	);
	const paddingStart = Number.isFinite(parsedPaddingStart)
		? parsedPaddingStart
		: 0;
	const paddingEnd = Number.isFinite(parsedPaddingEnd) ? parsedPaddingEnd : 0;
	// Measure the list with the same fractional, untransformed box the trigger
	// widths come from. `clientWidth` rounds to an integer, so a content-sized
	// (`w-fit`) row whose tabs fit exactly could read up to half a pixel short
	// and push its last tab into the More menu, where it never renders to widen
	// the row back.
	const parsedBorderStart = Number.parseFloat(
		isVertical ? computedStyle.borderTopWidth : computedStyle.borderLeftWidth
	);
	const parsedBorderEnd = Number.parseFloat(
		isVertical
			? computedStyle.borderBottomWidth
			: computedStyle.borderRightWidth
	);
	const available =
		measureTabLayoutSize(list, isVertical) -
		(Number.isFinite(parsedBorderStart) ? parsedBorderStart : 0) -
		(Number.isFinite(parsedBorderEnd) ? parsedBorderEnd : 0) -
		paddingStart -
		paddingEnd;
	const moreSize =
		reserveMore && moreTrigger
			? measureTabLayoutSize(moreTrigger, isVertical)
			: 0;
	const moreSpace = reserveMore
		? moreSize + (candidates.length > 0 ? gap : 0)
		: 0;
	const availableForTabs = Math.max(0, available - moreSpace);
	const fitted: string[] = [];
	let used = 0;

	for (const key of candidates) {
		const size = widths.get(key) ?? (isVertical ? 36 : 112);
		const nextUsed = used + (fitted.length > 0 ? gap : 0) + size;
		if (
			fitted.length > 0 &&
			nextUsed > availableForTabs + TAB_FIT_SUBPIXEL_TOLERANCE_PX
		) {
			continue;
		}
		fitted.push(key);
		used = nextUsed;
	}

	const visible = fitted.length > 0 ? fitted : [firstCandidate];
	if (activeKey && order.includes(activeKey) && !visible.includes(activeKey)) {
		const replacement = visible.at(-1);
		if (replacement) {
			return {
				keys: [...visible.slice(0, -1), activeKey],
				promotedKey: activeKey,
			};
		}
		return { keys: [activeKey], promotedKey: activeKey };
	}
	return { keys: visible, promotedKey: null };
}

function sameKeys(first: string[] | null, second: string[]) {
	return (
		first !== null &&
		first.length === second.length &&
		first.every((key, index) => key === second[index])
	);
}

export {
	getDefaultStorageKey,
	getTabItems,
	type ManagedTabAttributes,
	measureTabLayoutSize,
	normalizeOrder,
	readPersistedLayout,
	reorderKeys,
	resolveTabsDrop,
	resolveVisibleTabKeys,
	sameKeys,
	TABS_DRAG_MIME,
	type TabItem,
	type TabsDragController,
	tabValueKey,
	writePersistedLayout,
};
