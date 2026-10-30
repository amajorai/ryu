"use client";
import type { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { useOptionalI18n } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cloneElement, useState } from "react";
import {
	resolveTabsDrop,
	TABS_DRAG_MIME,
	type TabItem,
	type TabsDragController,
} from "./tabs-layout.ts";
import { TabsLayoutMenuContent } from "./tabs-layout-menu.tsx";
import type { TabsValue } from "./tabs-root.tsx";
import { tabsTriggerClassName } from "./tabs-variants.ts";

/**
 * The overflow trigger's copy ("29 more" / "Show 29 more tabs") in the host
 * language. Falls back to English when no I18nProvider is mounted.
 */
function useMoreTabsCopy(moreCount: number): {
	label: string;
	triggerText: string;
} {
	const i18n = useOptionalI18n();
	const translate = (id: string, english: string, count?: number) => {
		const values = count === undefined ? {} : { count };
		return i18n
			? i18n.t(id, values, english)
			: english.replace("{count}", String(count ?? ""));
	};
	if (moreCount > 0) {
		return {
			label: translate(
				"common.show-more-tabs-count",
				"Show {count} more tabs",
				moreCount
			),
			triggerText: translate("common.more-count", "{count} more", moreCount),
		};
	}
	return {
		label: translate("common.show-more-tabs", "Show more tabs"),
		triggerText: translate("common.more", "More"),
	};
}

interface TabsMenuProps {
	activeKey: string | null;
	drag: TabsDragController;
	hiddenKeys: Set<string>;
	items: TabItem[];
	moreCount?: number;
	onHideToggle: (key: string) => void;
	onReset: () => void;
	onSelect: (value: TabsValue) => void;
	open: boolean;
	order: string[];
	setOpen: (open: boolean) => void;
	showTrigger: boolean;
}

function TabsMoreMenu({
	activeKey,
	drag,
	hiddenKeys,
	items,
	onHideToggle,
	moreCount = 0,
	onReset,
	onSelect,
	open,
	order,
	setOpen,
	showTrigger,
}: TabsMenuProps) {
	const { label, triggerText } = useMoreTabsCopy(moreCount);
	return (
		<DropdownMenu onOpenChange={(nextOpen) => setOpen(nextOpen)} open={open}>
			<DropdownMenuTrigger
				aria-hidden={!showTrigger}
				aria-label={label}
				className={cn(
					tabsTriggerClassName,
					"flex-initial shrink-0 text-muted-foreground!",
					!showTrigger && "pointer-events-none invisible absolute"
				)}
				data-tabs-more-trigger="true"
				data-tabs-more-visible={showTrigger ? "true" : "false"}
				tabIndex={showTrigger ? undefined : -1}
			>
				<span className="max-w-24 truncate">{triggerText}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="corner-squircle w-80 rounded-xl p-0"
			>
				<TabsLayoutMenuContent
					activeKey={activeKey}
					drag={drag}
					hiddenKeys={hiddenKeys}
					items={items}
					onClose={() => setOpen(false)}
					onHideToggle={onHideToggle}
					onReset={onReset}
					onSelect={onSelect}
					open={open}
					order={order}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface ManagedTabTriggerProps
	extends Omit<
		TabsMenuProps,
		"moreCount" | "open" | "setOpen" | "showTrigger"
	> {
	isPromoted: boolean;
	item: TabItem;
}

function ManagedTabTrigger({
	activeKey,
	drag,
	hiddenKeys,
	items,
	item,
	isPromoted,
	onHideToggle,
	onReset,
	onSelect,
	order,
}: ManagedTabTriggerProps) {
	const [open, setOpen] = useState(false);
	const isDragging = drag.draggingKey === item.key;
	// Triggers slide apart to preview the drop; the ring is only a fallback.
	const isDragOver =
		drag.dropTarget?.key === item.key && !drag.shift.previewing;
	const originalProps = item.element.props;
	const shiftRef = useComposedRefs(
		originalProps.ref,
		drag.shift.register(item.key)
	);
	const shiftStyle = drag.shift.styleFor(item.key);
	const originalStyle = originalProps.style;
	const originalOnDragStart = originalProps.onDragStart;
	const originalOnDragEnd = originalProps.onDragEnd;
	const originalOnDragOver = originalProps.onDragOver;
	const originalOnDrop = originalProps.onDrop;

	const managedTrigger = cloneElement(item.element, {
		className: cn(
			originalProps.className,
			"cursor-grab active:cursor-grabbing",
			isDragging && "opacity-40",
			isDragOver && "data-[tabs-drop-target=true]:ring-2"
		),
		"data-tabs-dragging": isDragging ? "true" : undefined,
		"data-tabs-drop-target": isDragOver ? "true" : undefined,
		"data-tabs-managed-key": item.key,
		"data-tabs-managed-trigger": "true",
		"data-tabs-promoted": isPromoted ? "true" : undefined,
		draggable: true,
		ref: shiftRef,
		style:
			shiftStyle === undefined
				? originalStyle
				: typeof originalStyle === "function"
					? (state: Parameters<typeof originalStyle>[0]) => ({
							...originalStyle(state),
							...shiftStyle,
						})
					: { ...originalStyle, ...shiftStyle },
		onDragEnd: (
			event: Parameters<NonNullable<TabsPrimitive.Tab.Props["onDragEnd"]>>[0]
		) => {
			originalOnDragEnd?.(event);
			drag.onDragEnd();
		},
		onDragOver: (
			event: Parameters<NonNullable<TabsPrimitive.Tab.Props["onDragOver"]>>[0]
		) => {
			originalOnDragOver?.(event);
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "move";
			const target = resolveTabsDrop(
				drag,
				drag.shift,
				order,
				item.key,
				event,
				"x"
			);
			drag.onDragOver(target.key, target.before, event.currentTarget);
		},
		onDragStart: (
			event: Parameters<NonNullable<TabsPrimitive.Tab.Props["onDragStart"]>>[0]
		) => {
			originalOnDragStart?.(event);
			if (event.defaultPrevented) {
				return;
			}
			drag.onDragStart(item.key, event);
		},
		onDrop: (
			event: Parameters<NonNullable<TabsPrimitive.Tab.Props["onDrop"]>>[0]
		) => {
			originalOnDrop?.(event);
			event.preventDefault();
			event.stopPropagation();
			const target = resolveTabsDrop(
				drag,
				drag.shift,
				order,
				item.key,
				event,
				"x"
			);
			drag.onDrop(
				target.key,
				target.before,
				event.dataTransfer.getData(TABS_DRAG_MIME) || undefined
			);
		},
	});

	return (
		<ContextMenu onOpenChange={(nextOpen) => setOpen(nextOpen)} open={open}>
			<ContextMenuTrigger render={managedTrigger} />
			<ContextMenuContent className="w-80 p-0">
				<TabsLayoutMenuContent
					activeKey={activeKey}
					drag={drag}
					hiddenKeys={hiddenKeys}
					items={items}
					onClose={() => setOpen(false)}
					onHideToggle={onHideToggle}
					onReset={onReset}
					onSelect={onSelect}
					open={open}
					order={order}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export { ManagedTabTrigger, TabsMoreMenu };
