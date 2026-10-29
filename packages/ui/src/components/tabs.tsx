"use client";
import { z } from "zod";
import { observeNativeOptionalProperty } from "../lib/native-optional-property.mjs";
import {
	isNativeBoolean,
	isNativeFunction,
	isNativeNumber,
	isNativeText,
} from "../lib/native-primitive-observation.ts";

import "../styles/tabs.css";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	DragDropVerticalIcon,
	FilterResetIcon,
	MoreHorizontalIcon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText, useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	HORIZONTAL_SCROLLBAR_HIDDEN,
	type HorizontalOverflowEdges,
	useHorizontalOverflowState,
} from "@ryu/ui/components/edge-scroller.tsx";
import {
	type ReorderShift,
	useReorderShift,
} from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import {
	Children,
	type CSSProperties,
	cloneElement,
	createContext,
	type DragEvent,
	forwardRef,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

const useSafeLayoutEffect =
	globalThis.window === undefined ? useEffect : useLayoutEffect;

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

type TabsValue = TabsPrimitive.Tab.Props["value"];
type TabsChangeDetails = TabsPrimitive.Root.ChangeEventDetails;

interface TabsContextValue {
	activeValue: TabsValue | undefined;
	orientation: "horizontal" | "vertical";
	selectValue: (value: TabsValue) => boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
	const context = useContext(TabsContext);
	if (!context) {
		throw new Error("TabsList must be used inside Tabs");
	}
	return context;
}

function createProgrammaticChangeDetails(): TabsChangeDetails {
	let canceled = false;
	let propagationAllowed = false;
	return {
		reason: "none",
		event: new Event("ryu-tabs-selection"),
		cancel: () => {
			canceled = true;
		},
		allowPropagation: () => {
			propagationAllowed = true;
		},
		get isCanceled() {
			return canceled;
		},
		get isPropagationAllowed() {
			return propagationAllowed;
		},
		trigger: undefined,
		activationDirection: "none",
	};
}

function findFirstEnabledTabValue(children: ReactNode): TabsValue | undefined {
	for (const child of Children.toArray(children)) {
		if (!isValidElement<TabsPrimitive.Tab.Props>(child)) {
			continue;
		}
		const props = child.props;
		if ("value" in props && props.value !== undefined && !props.disabled) {
			return props.value;
		}
		const nestedValue = findFirstEnabledTabValue(props.children);
		if (nestedValue !== undefined) {
			return nestedValue;
		}
	}
	return undefined;
}

type TabsProps = TabsPrimitive.Root.Props & {
	spacing?: "flush" | "comfortable" | "relaxed" | "generous";
	inset?: "agent-activity" | "store-sections" | "library-sections";
};

function Tabs({
	className,
	spacing,
	inset,
	orientation = "horizontal",
	value,
	defaultValue,
	onValueChange,
	children,
	...props
}: TabsProps) {
	const initialValue =
		defaultValue === undefined
			? findFirstEnabledTabValue(children)
			: defaultValue;
	const [uncontrolledValue, setUncontrolledValue] = useState<
		TabsValue | undefined
	>(initialValue);
	const resolvedValue = value === undefined ? uncontrolledValue : value;

	const handleValueChange = useCallback(
		(nextValue: TabsValue, eventDetails: TabsChangeDetails) => {
			onValueChange?.(nextValue, eventDetails);
			if (!eventDetails.isCanceled) {
				setUncontrolledValue(nextValue);
			}
		},
		[onValueChange]
	);
	const selectValue = useCallback(
		(nextValue: TabsValue) => {
			const eventDetails = createProgrammaticChangeDetails();
			handleValueChange(nextValue, eventDetails);
			return !eventDetails.isCanceled;
		},
		[handleValueChange]
	);
	const contextValue = useMemo(
		() => ({
			activeValue: resolvedValue,
			orientation,
			selectValue,
		}),
		[orientation, resolvedValue, selectValue]
	);

	return (
		<TabsContext.Provider value={contextValue}>
			<TabsPrimitive.Root
				className={cn(
					"group/tabs flex gap-2 has-[[data-slot=tabs-list-sticky]]:flex-col-reverse data-horizontal:flex-col md:has-[[data-slot=tabs-list-sticky]]:flex-col",
					spacing === "flush" && "gap-0",
					spacing === "comfortable" && "gap-4",
					spacing === "relaxed" && "gap-3",
					spacing === "generous" && "gap-8",
					inset === "agent-activity" && "p-3",
					inset === "store-sections" && "pt-2 pb-1",
					inset === "library-sections" && "pt-2",
					className
				)}
				data-orientation={orientation}
				data-slot="tabs"
				defaultValue={resolvedValue === undefined ? defaultValue : undefined}
				onValueChange={handleValueChange}
				orientation={orientation}
				value={resolvedValue}
				{...props}
			>
				{children}
			</TabsPrimitive.Root>
		</TabsContext.Provider>
	);
}

const tabsListVariants = cva(
	// `relative` on every variant (not just segmented) so an optional sliding
	// TabsIndicator can anchor its absolute box against any list.
	"group/tabs-list group-data-vertical/tabs:corner-squircle relative inline-flex w-fit items-center justify-center rounded-full p-1 text-muted-foreground data-[variant=line]:rounded-none group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:rounded-2xl",
	{
		variants: {
			variant: {
				default: "bg-muted",
				line: "gap-1 bg-transparent",
				// Stepper: a rule ABOVE each label rather than an underline below the
				// active one, so the strip reads as a sequence of steps you can see the
				// whole of at once. Every step stays selectable — it suggests an order
				// without enforcing one, which is what separates it from `stepper.tsx`
				// (that primitive has a notion of "reached" and gates on it).
				stepper:
					"w-full items-start gap-4 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				pills:
					"flex-wrap gap-2 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Label-only tabs: use a larger text treatment without painting a pill
				// behind either the active or inactive label.
				text: "gap-4 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Same pill, more room. For surfaces where the tab strip IS the
				// primary control rather than a filter above a table — a share
				// dialog's Image/Video switch, say — and a 28px-tall pill reads as
				// incidental. Every `pills` rule below is written with a `^=pills`
				// prefix match so this variant inherits them and only overrides the
				// padding; duplicating a dozen classes per variant is how the two
				// would drift.
				"pills-lg":
					"flex-wrap gap-2 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				// Compact filter pills: the active tab is a muted wash rather than the
				// high-contrast foreground pill used by the primary `pills` variant.
				"muted-pills":
					"flex-wrap gap-1 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-fit",
				segmented: "relative gap-1 bg-muted",
			},
			layout: {
				"catalog-sections": "h-auto max-h-40 flex-wrap gap-1",
				"listing-detail": "h-auto flex-wrap gap-1",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

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

interface TabsLayoutMenuContentProps {
	activeKey: string | null;
	drag: TabsDragController;
	hiddenKeys: Set<string>;
	items: TabItem[];
	onClose: () => void;
	onHideToggle: (key: string) => void;
	onReset: () => void;
	onSelect: (value: TabsValue) => void;
	open: boolean;
	order: string[];
}

function TabsLayoutMenuContent({
	activeKey,
	drag,
	hiddenKeys,
	items,
	onClose,
	onHideToggle,
	onReset,
	onSelect,
	open,
	order,
}: TabsLayoutMenuContentProps) {
	const [query, setQuery] = useState("");
	const itemByKey = useMemo(
		() => new Map(items.map((item) => [item.key, item])),
		[items]
	);
	const visibleItemCount = items.length - hiddenKeys.size;

	useEffect(() => {
		if (!open) {
			setQuery("");
		}
	}, [open]);

	return (
		<Command className="min-h-0 w-full p-0" shouldFilter>
			<CommandInput
				aria-label="Search tabs"
				autoFocus
				onValueChange={setQuery}
				placeholder="Search tabs…"
				value={query}
			/>
			<CommandList className="max-h-80">
				<CommandEmpty>No tabs found.</CommandEmpty>
				<CommandGroup heading="All tabs">
					{order.map((key) => {
						const item = itemByKey.get(key);
						if (!item) {
							return null;
						}
						const isHidden = hiddenKeys.has(key);
						const isActive = activeKey === key;
						// Rows slide apart to preview the drop; the line is a fallback.
						const isDragOver =
							drag.dropTarget?.key === key && !drag.menuShift.previewing;
						const dropBelow = isDragOver && !drag.dropTarget?.before;
						return (
							<CommandItem
								aria-current={isActive ? "page" : undefined}
								className={cn(
									"relative min-h-8 gap-1.5",
									isHidden && "text-muted-foreground opacity-50"
								)}
								data-tabs-menu-hidden={isHidden ? "true" : "false"}
								data-tabs-menu-key={key}
								key={key}
								onDragOver={(event) => {
									event.preventDefault();
									event.stopPropagation();
									event.dataTransfer.dropEffect = "move";
									const target = resolveTabsDrop(
										drag,
										drag.menuShift,
										order,
										key,
										event,
										"y"
									);
									drag.onDragOver(target.key, target.before);
								}}
								onDrop={(event) => {
									event.preventDefault();
									event.stopPropagation();
									const target = resolveTabsDrop(
										drag,
										drag.menuShift,
										order,
										key,
										event,
										"y"
									);
									drag.onDrop(
										target.key,
										target.before,
										event.dataTransfer.getData(TABS_DRAG_MIME) || undefined
									);
								}}
								onSelect={() => {
									onSelect(item.value);
									onClose();
								}}
								ref={drag.menuShift.register(key)}
								style={drag.menuShift.styleFor(key)}
								value={`${item.label} ${key}`}
							>
								{isDragOver && (
									<span
										aria-hidden
										className={cn(
											"pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary",
											dropBelow ? "bottom-0" : "top-0"
										)}
									/>
								)}
								<button
									aria-label={`Reorder ${item.label}`}
									className="corner-squircle flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground active:cursor-grabbing"
									draggable
									onClick={(event) => event.stopPropagation()}
									onDragEnd={drag.onDragEnd}
									onDragStart={(event) => {
										event.stopPropagation();
										drag.onDragStart(key, event);
									}}
									onPointerDown={(event) => event.stopPropagation()}
									type="button"
								>
									<HugeiconsIcon
										aria-hidden
										className="size-3.5"
										icon={DragDropVerticalIcon}
										strokeWidth={2}
									/>
								</button>
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{isHidden && (
									<HugeiconsIcon
										aria-hidden
										className="size-3.5 shrink-0"
										data-tabs-menu-hidden-indicator="true"
										icon={ViewOffSlashIcon}
										strokeWidth={2}
									/>
								)}
								{isActive && <span className="sr-only">Active</span>}
								<DropdownMenu>
									<DropdownMenuTrigger
										aria-label={`More actions for ${item.label}`}
										className="corner-squircle flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
										onClick={(event) => event.stopPropagation()}
										onPointerDown={(event) => event.stopPropagation()}
										type="button"
									>
										<HugeiconsIcon
											aria-hidden
											className="size-3.5"
											icon={MoreHorizontalIcon}
											strokeWidth={2}
										/>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-36 p-1">
										<DropdownMenuItem
											disabled={!isHidden && visibleItemCount <= 1}
											onClick={(event) => {
												event.stopPropagation();
												onHideToggle(key);
											}}
										>
											<HugeiconsIcon
												aria-hidden
												className="size-3.5"
												icon={isHidden ? ViewIcon : ViewOffSlashIcon}
												strokeWidth={2}
											/>
											{isHidden ? `Show ${item.label}` : `Hide ${item.label}`}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</CommandItem>
						);
					})}
				</CommandGroup>
			</CommandList>
			<div className="px-1 pb-1">
				<CommandSeparator />
				<Button
					className="mt-1 w-full justify-start"
					onClick={() => {
						onReset();
						onClose();
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={FilterResetIcon}
						strokeWidth={2}
					/>
					Reset tabs
				</Button>
			</div>
		</Command>
	);
}

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

const TAB_SCROLL_PAGE_FRACTION = 0.8;

interface TabsOverflowNavigationProps {
	children: ReactElement;
	edges: HorizontalOverflowEdges;
	listId: string;
	onScrollPage: (direction: -1 | 1) => void;
}

function TabsOverflowNavigation({
	children,
	edges,
	listId,
	onScrollPage,
}: TabsOverflowNavigationProps) {
	const hasOverflow = edges.start || edges.end;

	return (
		<div
			className="group/tabs-overflow relative isolate min-w-0"
			data-slot="tabs-list-overflow"
		>
			{children}
			{hasOverflow ? (
				<>
					{edges.start ? (
						<span
							aria-hidden="true"
							className="corner-l-squircle pointer-events-none absolute inset-y-0 left-0 z-10 w-10 rounded-l-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_right,black,transparent)]"
						/>
					) : null}
					{edges.end ? (
						<span
							aria-hidden="true"
							className="corner-r-squircle pointer-events-none absolute inset-y-0 right-0 z-10 w-10 rounded-r-[inherit] backdrop-blur-[2px] [mask-image:linear-gradient(to_left,black,transparent)]"
						/>
					) : null}
					<div
						aria-label="Tab scrolling controls"
						className="pointer-events-none absolute inset-0 z-20"
						data-slot="tabs-overflow-controls"
						role="group"
					>
						<Button
							aria-controls={listId}
							aria-label="Scroll tabs left"
							className="pointer-events-auto absolute inset-y-0 left-0 z-20 h-full w-9 rounded-r-none rounded-l-full border-0 bg-transparent p-0 text-foreground shadow-none hover:bg-transparent focus-visible:bg-transparent disabled:pointer-events-none disabled:opacity-0"
							disabled={!edges.start}
							onClick={() => onScrollPage(-1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon
								aria-hidden
								icon={ArrowLeft01Icon}
								strokeWidth={2}
							/>
						</Button>
						<Button
							aria-controls={listId}
							aria-label="Scroll tabs right"
							className="pointer-events-auto absolute inset-y-0 right-0 z-20 h-full w-9 rounded-r-full rounded-l-none border-0 bg-transparent p-0 text-foreground shadow-none hover:bg-transparent focus-visible:bg-transparent disabled:pointer-events-none disabled:opacity-0"
							disabled={!edges.end}
							onClick={() => onScrollPage(1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon
								aria-hidden
								icon={ArrowRight01Icon}
								strokeWidth={2}
							/>
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}

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
	const revealTab = useCallback(
		(tab: HTMLElement | null) => {
			const list = listRef.current;
			if (!(isScrollable && list && tab)) {
				return;
			}
			const listBounds = list.getBoundingClientRect();
			const tabBounds = tab.getBoundingClientRect();
			const max = Math.max(0, list.scrollWidth - list.clientWidth);
			const rtl = getComputedStyle(list).direction === "rtl";
			const fromLeft = Math.max(
				0,
				Math.min(max, rtl ? max + list.scrollLeft : list.scrollLeft)
			);
			const left = listBounds.left + (fromLeft > 1 ? 36 : 0);
			const right = listBounds.right - (fromLeft < max - 1 ? 36 : 0);
			const delta =
				tabBounds.left < left
					? tabBounds.left - left
					: tabBounds.right > right
						? tabBounds.right - right
						: 0;
			if (delta === 0) {
				return;
			}
			const reduceMotion =
				globalThis.window !== undefined &&
				window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
			list.scrollBy({
				left: delta,
				behavior: reduceMotion ? "auto" : "smooth",
			});
		},
		[isScrollable]
	);
	useSafeLayoutEffect(() => {
		if (!isScrollable) {
			return;
		}
		overflowState.measure();
		revealTab(
			listRef.current?.querySelector<HTMLElement>(
				'[role="tab"][aria-selected="true"]'
			) ?? null
		);
	}, [
		activeValue,
		isScrollable,
		itemKeysSignature,
		overflowState.measure,
		revealTab,
	]);

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

	useSafeLayoutEffect(() => {
		const list = listRef.current;
		if (!list || items.length === 0) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			for (const trigger of list.querySelectorAll<HTMLElement>(
				"[data-tabs-managed-trigger]"
			)) {
				const key = trigger.getAttribute("data-tabs-managed-key");
				if (!key) {
					continue;
				}
				widthsRef.current.set(
					key,
					measureTabLayoutSize(trigger, orientation === "vertical")
				);
			}
			// A tab that was not rendered in this frame and has never been measured
			// (one added after mount, e.g. README/API arriving with a detail payload,
			// measured by a frame scheduled before the item-change reset rendered it) has
			// no width to fit with. Fitting it on a guess can overflow it into the
			// More menu, where it is never rendered and so never re-measured. Render
			// the full row for one frame instead; that frame measures every tab.
			// Once per tab set, so a trigger that never reaches the DOM falls back
			// to the guess instead of re-rendering every frame.
			if (
				fullRowMeasureSignatureRef.current !== itemKeysSignature &&
				normalizedOrder.some(
					(key) => !(hiddenKeys.has(key) || widthsRef.current.has(key))
				)
			) {
				fullRowMeasureSignatureRef.current = itemKeysSignature;
				setVisibleKeys(null);
				setPromotedKey(null);
				setMeasureVersion((version) => version + 1);
				return;
			}
			const nextResolution = resolveVisibleTabKeys(list, {
				activeKey,
				hiddenKeys,
				orientation,
				order: normalizedOrder,
				reserveMore: showMoreMenu,
				widths: widthsRef.current,
			});
			setVisibleKeys((current) =>
				sameKeys(current, nextResolution.keys) ? current : nextResolution.keys
			);
			setPromotedKey((current) =>
				current === nextResolution.promotedKey
					? current
					: nextResolution.promotedKey
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [
		activeKey,
		hiddenKeys,
		items.length,
		itemKeysSignature,
		measureVersion,
		normalizedOrder,
		orientation,
		showMoreMenu,
	]);

	useEffect(() => {
		const list = listRef.current;
		if (!list || globalThis.ResizeObserver === undefined) {
			return;
		}
		const observer = new ResizeObserver(() => {
			setMeasureVersion((version) => version + 1);
		});
		observer.observe(list);
		for (const trigger of list.querySelectorAll<HTMLElement>(
			"[data-tabs-managed-trigger]"
		)) {
			observer.observe(trigger);
		}
		const moreTrigger = list.querySelector<HTMLElement>(
			"[data-tabs-more-trigger]"
		);
		if (moreTrigger) {
			observer.observe(moreTrigger);
		}
		return () => observer.disconnect();
	}, [displayedKeys, items.length]);

	const clearDrag = useCallback(() => {
		draggingKeyRef.current = null;
		setDraggingKey(null);
		setDropTarget(null);
		setInlineIndicator(null);
	}, []);
	const commitReorder = useCallback(
		(sourceKey: string, targetKey: string, before: boolean) => {
			setOrder((current) =>
				reorderKeys(
					normalizeOrder(current, itemKeys),
					sourceKey,
					targetKey,
					before
				)
			);
			setVisibleKeys(null);
			setPromotedKey(null);
		},
		[itemKeys]
	);
	const drag = useMemo<TabsDragController>(
		() => ({
			draggingKey,
			dropTarget,
			menuShift,
			onDragEnd: clearDrag,
			onDragOver: (key, before, element) => {
				const sourceKey = draggingKeyRef.current ?? draggingKey;
				if (!sourceKey) {
					return;
				}
				if (sourceKey === key) {
					// Back over its own resting slot: nothing moves.
					setDropTarget(null);
					setInlineIndicator(null);
					return;
				}
				setDropTarget({ before, key });
				if (!(element && listRef.current)) {
					return;
				}
				const listRect = listRef.current.getBoundingClientRect();
				const rect = element.getBoundingClientRect();
				if (orientation === "vertical") {
					setInlineIndicator({
						height: 2,
						left: rect.left - listRect.left + 4,
						top: (before ? rect.top : rect.bottom) - listRect.top - 1,
						width: Math.max(0, rect.width - 8),
					});
				} else {
					setInlineIndicator({
						height: Math.max(0, rect.height - 8),
						left: (before ? rect.left : rect.right) - listRect.left - 1,
						top: rect.top - listRect.top + 4,
						width: 2,
					});
				}
			},
			onDragStart: (key, event) => {
				draggingKeyRef.current = key;
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(TABS_DRAG_MIME, key);
				event.dataTransfer.setData("text/plain", key);
				setDraggingKey(key);
				setDropTarget(null);
				setInlineIndicator(null);
			},
			onDrop: (key, before, sourceKey) => {
				const source = sourceKey ?? draggingKeyRef.current ?? draggingKey;
				if (source && source !== key) {
					commitReorder(source, key, before);
				}
				clearDrag();
			},
			shift: triggerShift,
		}),
		[
			clearDrag,
			commitReorder,
			draggingKey,
			dropTarget,
			menuShift,
			orientation,
			triggerShift,
		]
	);

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

type TabsTriggerProps = TabsPrimitive.Tab.Props & {
	density?: "review" | "catalog";
	typography?: "pricing-plan" | "pricing-audience";
	labelCase?: "capitalize";
	spacing?: "store-section";
	tone?: "muted";
};

function TabsTrigger({
	children,
	className,
	density,
	typography,
	labelCase,
	spacing,
	tone,
	...props
}: TabsTriggerProps) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<TabsPrimitive.Tab
			className={cn(
				tabsTriggerClassName,
				density === "review" && "t-tabs-trigger-review",
				density === "catalog" && "gap-1.5 px-2.5 py-1 text-xs",
				typography === "pricing-plan" && "text-base! sm:text-xl!",
				typography === "pricing-audience" && "text-base",
				labelCase === "capitalize" && "capitalize",
				spacing === "store-section" && "gap-1.5",
				tone === "muted" && "text-muted-foreground",
				className
			)}
			data-cuelume-toggle=""
			data-slot="tabs-trigger"
			{...props}
		>
			{localizedChildren}
		</TabsPrimitive.Tab>
	);
}

const tabsTriggerClassName = cn(
	"t-tabs-trigger",
	"group-data-vertical/tabs:corner-squircle relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent! px-3 py-1 font-medium text-foreground/60 text-sm transition-[color,background-color,border-color,box-shadow] hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:rounded-2xl group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1.5 dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	"group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
	// The rule is the trigger's own `::before`, so the label sits under it
	// with no extra element. `whitespace-normal` because a three-word step
	// clipped to "Reserve your han…" in a narrow column loses the one
	// instruction it exists to give — the rules are what align the strip,
	// so a second line only makes it taller.
	"group-data-[variant=stepper]/tabs-list:corner-squircle group-data-[variant=stepper]/tabs-list:h-auto group-data-[variant=stepper]/tabs-list:flex-col group-data-[variant=stepper]/tabs-list:items-start group-data-[variant=stepper]/tabs-list:gap-2 group-data-[variant=stepper]/tabs-list:whitespace-normal group-data-[variant=stepper]/tabs-list:rounded-sm group-data-[variant=stepper]/tabs-list:px-0 group-data-[variant=stepper]/tabs-list:py-0 group-data-[variant=stepper]/tabs-list:text-start group-data-[variant=stepper]/tabs-list:text-muted-foreground/60 group-data-[variant=stepper]/tabs-list:text-xs",
	"group-data-[variant=stepper]/tabs-list:before:h-1 group-data-[variant=stepper]/tabs-list:before:w-full group-data-[variant=stepper]/tabs-list:before:rounded-full group-data-[variant=stepper]/tabs-list:before:bg-border group-data-[variant=stepper]/tabs-list:before:transition-colors group-data-[variant=stepper]/tabs-list:before:content-['']",
	"group-data-[variant=stepper]/tabs-list:data-active:bg-transparent! group-data-[variant=stepper]/tabs-list:data-active:text-foreground group-data-[variant=stepper]/tabs-list:data-active:after:opacity-0 group-data-[variant=stepper]/tabs-list:data-active:before:bg-foreground",
	// `pills-lg` deliberately resolves to the same box as `pills`. The prefix
	// match covers both names so the two cannot drift again.
	"group-data-[variant^=pills]/tabs-list:h-auto group-data-[variant^=pills]/tabs-list:flex-initial group-data-[variant^=pills]/tabs-list:gap-2 group-data-[variant^=pills]/tabs-list:rounded-full group-data-[variant^=pills]/tabs-list:px-4 group-data-[variant^=pills]/tabs-list:py-2 group-data-[variant^=pills]/tabs-list:text-foreground group-data-[variant^=pills]/tabs-list:text-sm group-data-[variant^=pills]/tabs-list:hover:bg-black/5 group-data-[variant^=pills]/tabs-list:hover:text-foreground dark:group-data-[variant^=pills]/tabs-list:text-foreground dark:group-data-[variant^=pills]/tabs-list:hover:bg-white/10",
	"group-data-[variant^=pills]/tabs-list:data-active:border-transparent! group-data-[variant^=pills]/tabs-list:data-active:bg-black! group-data-[variant^=pills]/tabs-list:data-active:text-white! dark:group-data-[variant^=pills]/tabs-list:data-active:bg-white! dark:group-data-[variant^=pills]/tabs-list:data-active:text-black!",
	"group-data-[variant=text]/tabs-list:h-auto group-data-[variant=text]/tabs-list:flex-initial group-data-[variant=text]/tabs-list:gap-1 group-data-[variant=text]/tabs-list:rounded-none group-data-[variant=text]/tabs-list:bg-transparent! group-data-[variant=text]/tabs-list:px-0 group-data-[variant=text]/tabs-list:py-0 group-data-[variant=text]/tabs-list:text-base group-data-[variant=text]/tabs-list:text-muted-foreground group-data-[variant=text]/tabs-list:hover:bg-transparent! group-data-[variant=text]/tabs-list:hover:text-foreground dark:group-data-[variant=text]/tabs-list:text-muted-foreground dark:group-data-[variant=text]/tabs-list:hover:text-foreground",
	"group-data-[variant=text]/tabs-list:data-active:border-transparent! group-data-[variant=text]/tabs-list:data-active:bg-transparent! group-data-[variant=text]/tabs-list:data-active:text-foreground! dark:group-data-[variant=text]/tabs-list:data-active:bg-transparent! dark:group-data-[variant=text]/tabs-list:data-active:text-foreground!",
	"group-data-[variant=muted-pills]/tabs-list:h-auto group-data-[variant=muted-pills]/tabs-list:flex-initial group-data-[variant=muted-pills]/tabs-list:gap-1 group-data-[variant=muted-pills]/tabs-list:rounded-full group-data-[variant=muted-pills]/tabs-list:px-1 group-data-[variant=muted-pills]/tabs-list:py-1 group-data-[variant=muted-pills]/tabs-list:text-muted-foreground group-data-[variant=muted-pills]/tabs-list:text-xs group-data-[variant=muted-pills]/tabs-list:hover:bg-muted/60 group-data-[variant=muted-pills]/tabs-list:hover:text-foreground",
	"group-data-[variant=muted-pills]/tabs-list:data-active:border-transparent! group-data-[variant=muted-pills]/tabs-list:data-active:bg-muted! group-data-[variant=muted-pills]/tabs-list:data-active:text-foreground! dark:group-data-[variant=muted-pills]/tabs-list:data-active:bg-muted!",
	"data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
	// Segmented: the sliding TabsIndicator owns the active background, so the
	// trigger itself stays transparent and only animates its text colour. It
	// sits above the indicator (z-10) so the label reads on top of the pill.
	"group-data-[variant=segmented]/tabs-list:z-10 group-data-[variant=segmented]/tabs-list:bg-transparent! group-data-[variant=segmented]/tabs-list:text-foreground/60 group-data-[variant=segmented]/tabs-list:data-active:border-transparent! group-data-[variant=segmented]/tabs-list:data-active:bg-transparent! group-data-[variant=segmented]/tabs-list:data-active:text-foreground group-data-[variant=segmented]/tabs-list:hover:text-foreground dark:group-data-[variant=segmented]/tabs-list:data-active:bg-transparent!",
	"after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
	// When a sliding TabsIndicator is present in the list, hand the active
	// visual (background / border / underline) over to it and keep the
	// trigger's own only its text colour.
	"group-has-[[data-slot=tabs-indicator]]/tabs-list:z-10 group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:border-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:hover:bg-transparent! group-has-[[data-slot=tabs-indicator]]/tabs-list:data-active:after:opacity-0"
);

/**
 * Sliding active-tab indicator (transitions.dev "tabs sliding", 16). Base UI
 * positions it over the active tab via the --active-tab-* CSS vars; the
 * `t-tabs-indicator` class (globals.css) tweens transform/width/height.
 * TabsList includes one automatically except for text and stepper variants.
 * Supply an explicit child to customize its look. Layout changes snap into
 * position; selecting a tab slides its marker without moving the labels.
 */
function TabsIndicator({
	className,
	ref,
	...props
}: TabsPrimitive.Indicator.Props) {
	const indicatorRef = useRef<HTMLSpanElement>(null);
	const composedRef = useComposedRefs(indicatorRef, ref);
	const { activeValue } = useTabsContext();
	const hasSelection = activeValue != null;

	useSafeLayoutEffect(() => {
		const indicator = indicatorRef.current;
		const list = indicator?.parentElement;
		if (!(indicator && list)) {
			return;
		}
		let frame = 0;
		const snapToLayout = () => {
			indicator.setAttribute("data-resizing", "");
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(() => {
					// Commit Base UI's measured position before restoring transitions.
					indicator.getBoundingClientRect();
					indicator.removeAttribute("data-resizing");
				});
			});
		};
		const observer = new ResizeObserver(snapToLayout);
		const observeTabs = () => {
			observer.disconnect();
			observer.observe(list);
			for (const trigger of list.querySelectorAll('[role="tab"]')) {
				observer.observe(trigger);
			}
		};
		observeTabs();
		const mutations = new MutationObserver(observeTabs);
		mutations.observe(list, { childList: true, subtree: true });
		return () => {
			mutations.disconnect();
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [hasSelection]);

	return (
		<TabsPrimitive.Indicator
			aria-hidden
			className={cn(
				// default + segmented: the raised pill.
				"t-tabs-indicator z-0 rounded-full bg-background shadow-sm dark:bg-input/30",
				// pills: a solid black (light) / white (dark) pill, no shadow.
				"group-data-[variant^=pills]/tabs-list:bg-black group-data-[variant^=pills]/tabs-list:shadow-none dark:group-data-[variant^=pills]/tabs-list:bg-white",
				"group-data-[variant=muted-pills]/tabs-list:bg-muted group-data-[variant=muted-pills]/tabs-list:shadow-none dark:group-data-[variant=muted-pills]/tabs-list:bg-muted",
				// line: a bottom bar instead of a filled pill.
				"group-data-vertical/tabs:group-data-[variant=line]/tabs-list:border-r-2 group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-foreground group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:shadow-none",
				className
			)}
			data-slot="tabs-indicator"
			ref={composedRef}
			{...props}
		/>
	);
}

type TabsContentProps = TabsPrimitive.Panel.Props & {
	inset?: "review" | "listing-detail" | "agent-activity";
	layout?:
		| "agent-activity"
		| "agent-settings"
		| "install-instructions"
		| "sticky-showcase";
	spacing?: "comfortable" | "relaxed" | "generous";
	appearance?: "layout-proof";
};

function TabsContent({
	className,
	inset,
	layout,
	spacing,
	appearance,
	...props
}: TabsContentProps) {
	return (
		<TabsPrimitive.Panel
			className={cn(
				"flex-1 text-sm outline-none",
				inset === "review" && "t-tabs-panel-review",
				inset === "listing-detail" && "pt-2",
				layout === "agent-activity" && "flex flex-col gap-5",
				layout === "agent-settings" && "flex flex-col gap-6 pt-1",
				layout === "install-instructions" && "flex flex-col gap-3",
				layout === "sticky-showcase" && "flex flex-col gap-4 pt-4",
				inset === "agent-activity" && "px-1 pb-3",
				spacing === "comfortable" && "space-y-6",
				spacing === "relaxed" && "space-y-4",
				spacing === "generous" && "space-y-10",
				appearance === "layout-proof" &&
					"rounded-lg border bg-muted/30 p-4 text-sm",
				className
			)}
			data-slot="tabs-content"
			{...props}
		/>
	);
}

export {
	resolveVisibleTabKeys,
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
	tabsListVariants,
};
