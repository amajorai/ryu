"use client";
import {
	isNativeFunction,
	isNativeNumber,
} from "../lib/native-primitive-observation.ts";

import "../styles/tabs.css";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import {
	HORIZONTAL_SCROLLBAR_HIDDEN,
	useHorizontalOverflowState,
} from "@ryu/ui/components/edge-scroller.tsx";
import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { VariantProps } from "class-variance-authority";
import {
	type CSSProperties,
	forwardRef,
	isValidElement,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { TabsContent } from "./tabs-content.tsx";
import { TabsIndicator } from "./tabs-indicator.tsx";
import {
	getDefaultStorageKey,
	getTabItems,
	normalizeOrder,
	readPersistedLayout,
	resolveVisibleTabKeys,
	sameKeys,
	type TabItem,
	tabValueKey,
	writePersistedLayout,
} from "./tabs-layout.ts";
import { useTabsDragController } from "./tabs-list-drag.ts";
import { useTabsListFit, useTabsScrollReveal } from "./tabs-list-fit.ts";
import { ManagedTabTrigger, TabsMoreMenu } from "./tabs-more-menu.tsx";
import {
	TAB_SCROLL_PAGE_FRACTION,
	TabsOverflowNavigation,
} from "./tabs-overflow-navigation.tsx";
import { Tabs, type TabsValue, useTabsContext } from "./tabs-root.tsx";
import { TabsTrigger } from "./tabs-trigger.tsx";
import { tabsListVariants } from "./tabs-variants.ts";

interface TabsDropStyle extends CSSProperties {
	"--drop-height"?: string | undefined;
	"--drop-left"?: string | undefined;
	"--drop-top"?: string | undefined;
	"--drop-width"?: string | undefined;
}
interface TabsScrollStyle extends CSSProperties {
	"--tabs-mask-image"?: CSSProperties["maskImage"];
	"--tabs-webkit-mask-image"?: CSSProperties["WebkitMaskImage"];
}

interface TabsListProps
	extends TabsPrimitive.List.Props,
		VariantProps<typeof tabsListVariants> {
	/** Keep every trigger visible for fixed-choice controls. */
	manageLayout?: boolean;
	/** Disable layout persistence while keeping responsive overflow controls. */
	persistLayout?: boolean;
	/** Keep horizontal tabs visible while their content scrolls. */
	sticky?: boolean;
	/** Space for a fixed header above sticky tabs on desktop. Defaults to zero. */
	stickyOffset?: CSSProperties["top"];
	/** Stable storage namespace. Use this when a page has more than one tab list. */
	storageKey?: string;
}

type StickyTabsListStyle = CSSProperties & {
	"--tabs-sticky-offset": NonNullable<CSSProperties["top"]>;
};

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
	{
		children,
		className,
		id,
		manageLayout = true,
		persistLayout = true,
		style: customStyle,
		storageKey: storageKeyProp,
		sticky = false,
		stickyOffset = 0,
		variant = "default",
		layout,
		...props
	},
	ref
) {
	const { activeValue, orientation, selectValue } = useTabsContext();
	const stickyStyle: StickyTabsListStyle = {
		"--tabs-sticky-offset": isNativeNumber(stickyOffset)
			? `${stickyOffset}px`
			: stickyOffset,
	};
	const wrapSticky = (list: ReactNode) =>
		sticky && orientation === "horizontal" ? (
			<div
				className="sticky bottom-0 z-20 min-w-0 shrink-0 border-t bg-background pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:top-[var(--tabs-sticky-offset)] md:bottom-auto md:border-t-0 md:pb-2"
				data-slot="tabs-list-sticky"
				style={stickyStyle}
			>
				{list}
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-full h-10 bg-linear-to-t from-background to-transparent md:top-full md:bottom-auto md:bg-linear-to-b"
					data-slot="tabs-list-fade"
				/>
			</div>
		) : (
			list
		);
	const { items, staticChildren } = useMemo(
		() => getTabItems(children),
		[children]
	);
	const automaticIndicator =
		variant !== "text" &&
		variant !== "stepper" &&
		!staticChildren.some(
			(child) => isValidElement(child) && child.type === TabsIndicator
		) ? (
			<TabsIndicator />
		) : null;
	const isScrollable = manageLayout === false && orientation === "horizontal";
	const nextItemKeys = items.map((item) => item.key);
	const itemKeysSignature = nextItemKeys.join("\u0000");
	const itemKeys = useMemo(() => nextItemKeys, [itemKeysSignature]);
	const generatedStorageId = useId();
	const overflowListId = id ?? generatedStorageId;
	const storageKey =
		persistLayout === false
			? null
			: `${storageKeyProp ?? getDefaultStorageKey(id ?? generatedStorageId, String(variant ?? "default"))}`;
	const [order, setOrder] = useState(itemKeys);
	const [hiddenKeyList, setHiddenKeyList] = useState<string[]>([]);
	const [hydrated, setHydrated] = useState(false);
	const [visibleKeys, setVisibleKeys] = useState<string[] | null>(null);
	const [promotedKey, setPromotedKey] = useState<string | null>(null);
	const [measureVersion, setMeasureVersion] = useState(0);
	const [moreOpen, setMoreOpen] = useState(false);
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{
		before: boolean;
		key: string;
	} | null>(null);
	const [inlineIndicator, setInlineIndicator] = useState<{
		height: number;
		left: number;
		top: number;
		width: number;
	} | null>(null);
	const reorderTarget = {
		activeId: draggingKey,
		before: dropTarget?.before,
		overId: dropTarget?.key ?? null,
	};
	const triggerShift = useReorderShift({
		...reorderTarget,
		axis: orientation === "vertical" ? "y" : "x",
	});
	const menuShift = useReorderShift({ ...reorderTarget, axis: "y" });
	const listRef = useRef<HTMLDivElement | null>(null);
	const widthsRef = useRef(new Map<string, number>());
	const draggingKeyRef = useRef<string | null>(null);
	const loadedStorageKeyRef = useRef<string | null>(null);
	const fullRowMeasureSignatureRef = useRef<string | null>(null);
	const composedListRef = useComposedRefs(listRef, ref);
	const overflowState = useHorizontalOverflowState(listRef, isScrollable);
	const scrollStyle: TabsScrollStyle = {
		...customStyle,
		"--tabs-mask-image":
			overflowState.style?.maskImage ??
			(isNativeFunction(customStyle) ? undefined : customStyle?.maskImage),
		"--tabs-webkit-mask-image":
			overflowState.style?.WebkitMaskImage ??
			(isNativeFunction(customStyle)
				? undefined
				: customStyle?.WebkitMaskImage),
	};
	const dropStyle: TabsDropStyle = {
		"--drop-height": inlineIndicator
			? `${inlineIndicator.height}px`
			: undefined,
		"--drop-left": inlineIndicator ? `${inlineIndicator.left}px` : undefined,
		"--drop-top": inlineIndicator ? `${inlineIndicator.top}px` : undefined,
		"--drop-width": inlineIndicator ? `${inlineIndicator.width}px` : undefined,
	};
	const revealTab = useTabsScrollReveal({
		activeValue,
		isScrollable,
		itemKeysSignature,
		listRef,
		overflowState,
	});

	const normalizedOrder = useMemo(
		() => normalizeOrder(order, itemKeys),
		[order, itemKeys]
	);
	const hiddenKeys = useMemo(
		() => new Set(hiddenKeyList.filter((key) => itemKeys.includes(key))),
		[hiddenKeyList, itemKeys]
	);
	const activeKey =
		activeValue === undefined || activeValue === null
			? null
			: tabValueKey(activeValue);
	const activeHidden = activeKey !== null && hiddenKeys.has(activeKey);
	const displayedKeys = visibleKeys ?? [
		...normalizedOrder.filter((key) => !hiddenKeys.has(key)),
		...(activeHidden ? [activeKey] : []),
	];
	const displayedKeySet = useMemo(
		() => new Set(displayedKeys),
		[displayedKeys]
	);
	const hiddenOrOverflowCount = items.filter(
		(item) => !displayedKeySet.has(item.key)
	).length;
	const showMoreMenu =
		moreOpen ||
		hiddenKeys.size > 0 ||
		(visibleKeys !== null && hiddenOrOverflowCount > 0);
	const itemByKey = useMemo(
		() => new Map(items.map((item) => [item.key, item])),
		[items]
	);

	useEffect(() => {
		if (!storageKey) {
			loadedStorageKeyRef.current = storageKey;
			setHydrated(true);
			return;
		}
		if (loadedStorageKeyRef.current === storageKey) {
			return;
		}
		loadedStorageKeyRef.current = storageKey;
		const persisted = readPersistedLayout(storageKey);
		if (persisted) {
			setOrder(normalizeOrder(persisted.order, itemKeys));
			setHiddenKeyList(
				persisted.hidden.filter((key) => itemKeys.includes(key))
			);
		}
		setHydrated(true);
	}, [itemKeys, storageKey]);

	useEffect(() => {
		setOrder((current) => {
			const next = normalizeOrder(current, itemKeys);
			return sameKeys(current, next) ? current : next;
		});
	}, [itemKeys]);

	useEffect(() => {
		if (!(hydrated && storageKey)) {
			return;
		}
		writePersistedLayout(storageKey, normalizedOrder, [...hiddenKeys]);
	}, [hydrated, hiddenKeys, normalizedOrder, storageKey]);

	useEffect(() => {
		setVisibleKeys(null);
		setPromotedKey(null);
		setMeasureVersion((version) => version + 1);
	}, [activeKey, hiddenKeyList, itemKeysSignature, normalizedOrder]);

	useTabsListFit({
		activeKey,
		displayedKeys,
		fullRowMeasureSignatureRef,
		hiddenKeys,
		itemKeysSignature,
		items,
		listRef,
		measureVersion,
		normalizedOrder,
		orientation,
		setMeasureVersion,
		setPromotedKey,
		setVisibleKeys,
		showMoreMenu,
		widthsRef,
	});

	const drag = useTabsDragController({
		draggingKey,
		draggingKeyRef,
		dropTarget,
		itemKeys,
		listRef,
		menuShift,
		orientation,
		setDraggingKey,
		setDropTarget,
		setInlineIndicator,
		setOrder,
		setPromotedKey,
		setVisibleKeys,
		triggerShift,
	});

	const toggleHidden = useCallback(
		(key: string) => {
			if (!hiddenKeys.has(key) && activeKey === key) {
				const fallbackKey = normalizedOrder.find(
					(candidate) => candidate !== key && !hiddenKeys.has(candidate)
				);
				const fallback = fallbackKey ? itemByKey.get(fallbackKey) : undefined;
				if (!(fallback && selectValue(fallback.value))) {
					return;
				}
			}
			setHiddenKeyList((current) =>
				current.includes(key)
					? current.filter((candidate) => candidate !== key)
					: [...current, key]
			);
		},
		[activeKey, hiddenKeys, itemByKey, normalizedOrder, selectValue]
	);
	const resetLayout = useCallback(() => {
		setOrder(itemKeys);
		setHiddenKeyList([]);
		setVisibleKeys(null);
		setPromotedKey(null);
	}, [itemKeys]);
	const handleSelect = useCallback(
		(valueToSelect: TabsValue) => {
			selectValue(valueToSelect);
		},
		[selectValue]
	);
	const scrollPage = useCallback((direction: -1 | 1) => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		const left =
			direction * Math.max(120, list.clientWidth * TAB_SCROLL_PAGE_FRACTION);
		const reducedMotion =
			globalThis.window !== undefined &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		list.scrollBy({
			behavior: reducedMotion ? "auto" : "smooth",
			left,
		});
	}, []);

	if (items.length === 0 || manageLayout === false) {
		const list = (
			<TabsPrimitive.List
				className={cn(
					tabsListVariants({ variant, layout }),
					className,
					isScrollable &&
						"max-h-full max-w-full flex-nowrap justify-start overflow-x-auto overflow-y-hidden overscroll-x-contain [&>[data-slot=tabs-trigger]]:flex-none",
					isScrollable && HORIZONTAL_SCROLLBAR_HIDDEN,
					isScrollable &&
						"[-webkit-mask-image:var(--tabs-webkit-mask-image)]! [mask-image:var(--tabs-mask-image)]!"
				)}
				data-edges={isScrollable ? overflowState.dataEdges : undefined}
				data-slot="tabs-list"
				data-tabs-overflow={isScrollable ? "true" : undefined}
				data-variant={variant}
				id={isScrollable ? overflowListId : id}
				ref={composedListRef}
				style={isScrollable ? scrollStyle : customStyle}
				{...props}
				onFocusCapture={(event) => {
					props.onFocusCapture?.(event);
					if (
						isScrollable &&
						!event.defaultPrevented &&
						event.target instanceof HTMLElement &&
						event.target.getAttribute("role") === "tab"
					) {
						revealTab(event.target);
					}
				}}
			>
				{children}
				{automaticIndicator}
			</TabsPrimitive.List>
		);
		if (!isScrollable) {
			return wrapSticky(list);
		}
		return wrapSticky(
			<TabsOverflowNavigation
				edges={overflowState.edges}
				listId={overflowListId}
				onScrollPage={scrollPage}
			>
				{list}
			</TabsOverflowNavigation>
		);
	}

	const displayedItems = displayedKeys
		.map((key) => itemByKey.get(key))
		.filter((item): item is TabItem => item !== undefined);
	return wrapSticky(
		<TabsPrimitive.List
			className={cn(
				tabsListVariants({ variant, layout }),
				className,
				"max-h-full max-w-full flex-nowrap overflow-hidden"
			)}
			data-slot="tabs-list"
			data-tabs-managed="true"
			data-variant={variant}
			ref={composedListRef}
			style={customStyle}
			{...props}
		>
			{displayedItems.map((item) => (
				<ManagedTabTrigger
					activeKey={activeKey}
					drag={drag}
					hiddenKeys={hiddenKeys}
					isPromoted={activeKey === item.key && promotedKey === item.key}
					item={item}
					items={items}
					key={item.key}
					onHideToggle={toggleHidden}
					onReset={resetLayout}
					onSelect={handleSelect}
					order={normalizedOrder}
				/>
			))}
			{inlineIndicator && !triggerShift.previewing && (
				<span
					aria-hidden
					className="pointer-events-none absolute top-[var(--drop-top)] left-[var(--drop-left)] z-20 h-[var(--drop-height)] w-[var(--drop-width)] rounded-full bg-primary"
					data-tabs-drop-indicator="true"
					style={dropStyle}
				/>
			)}
			<TabsMoreMenu
				activeKey={activeKey}
				drag={drag}
				hiddenKeys={hiddenKeys}
				items={items}
				moreCount={hiddenOrOverflowCount}
				onHideToggle={toggleHidden}
				onReset={resetLayout}
				onSelect={handleSelect}
				open={moreOpen}
				order={normalizedOrder}
				setOpen={setMoreOpen}
				showTrigger={showMoreMenu}
			/>
			{staticChildren}
			{automaticIndicator}
		</TabsPrimitive.List>
	);
});

export {
	resolveVisibleTabKeys,
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
	tabsListVariants,
};
