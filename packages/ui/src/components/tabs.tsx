"use client";

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
import { useLocalizedText } from "@ryu/i18n/react";
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
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { useComposedRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import {
	Children,
	cloneElement,
	createContext,
	type DragEvent,
	type DragEventHandler,
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
	typeof window === "undefined" ? useEffect : useLayoutEffect;

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
		if (!isValidElement(child)) {
			continue;
		}
		const props = child.props as {
			children?: ReactNode;
			disabled?: boolean;
			value?: TabsValue;
		};
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

function Tabs({
	className,
	orientation = "horizontal",
	value,
	defaultValue,
	onValueChange,
	children,
	...props
}: TabsPrimitive.Root.Props) {
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
					"group/tabs flex gap-2 data-horizontal:flex-col",
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
	"group/tabs-list relative inline-flex w-fit items-center justify-center rounded-full p-1 text-muted-foreground data-[variant=line]:rounded-none group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:rounded-2xl",
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
	/** Stable storage namespace. Use this when a page has more than one tab list. */
	storageKey?: string;
}

interface TabItem {
	element: ReactElement<TabsPrimitive.Tab.Props>;
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
	if (typeof value === "string") {
		return `string:${value}`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return `${typeof value}:${String(value)}`;
	}
	try {
		return `json:${JSON.stringify(value)}`;
	} catch {
		return `value:${String(value)}`;
	}
}

function textFromNode(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") {
		return String(node);
	}
	if (Array.isArray(node)) {
		return node.map(textFromNode).join(" ");
	}
	if (isValidElement(node)) {
		return textFromNode((node.props as { children?: ReactNode }).children);
	}
	return "";
}

function getTabItems(children: ReactNode): {
	items: TabItem[];
	staticChildren: ReactNode[];
} {
	const items: TabItem[] = [];
	const staticChildren: ReactNode[] = [];
	const seenKeys = new Set<string>();

	for (const child of Children.toArray(children)) {
		if (!isValidElement(child)) {
			staticChildren.push(child);
			continue;
		}
		const props = child.props as TabsPrimitive.Tab.Props & {
			[attribute: string]: unknown;
		};
		if (!("value" in props) || props.value === undefined) {
			staticChildren.push(child);
			continue;
		}
		const baseKey = tabValueKey(props.value);
		const key = seenKeys.has(baseKey) ? `${baseKey}:${items.length}` : baseKey;
		seenKeys.add(baseKey);
		const label =
			(typeof props["aria-label"] === "string" && props["aria-label"]) ||
			(typeof props.title === "string" && props.title) ||
			textFromNode(props.children).replace(/\s+/g, " ").trim() ||
			String(props.value);
		items.push({
			element: child as ReactElement<TabsPrimitive.Tab.Props>,
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

interface PersistedTabsLayout {
	hidden?: unknown;
	order?: unknown;
}

function readPersistedLayout(storageKey: string) {
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as PersistedTabsLayout;
		return {
			hidden: Array.isArray(parsed.hidden)
				? parsed.hidden.filter((key): key is string => typeof key === "string")
				: [],
			order: Array.isArray(parsed.order)
				? parsed.order.filter((key): key is string => typeof key === "string")
				: [],
		};
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
		typeof window === "undefined" ? "server" : window.location.pathname;
	return `${TABS_STORAGE_PREFIX}:${locationKey}:${id ?? variant ?? "default"}`;
}

interface TabsDragController {
	draggingKey: string | null;
	dropTarget: { before: boolean; key: string } | null;
	onDragEnd: () => void;
	onDragOver: (key: string, before: boolean, element?: HTMLElement) => void;
	onDragStart: (key: string, event: DragEvent<HTMLElement>) => void;
	onDrop: (key: string, before: boolean, sourceKey?: string) => void;
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
						const isDragOver = drag.dropTarget?.key === key;
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
									const rect = event.currentTarget.getBoundingClientRect();
									drag.onDragOver(
										key,
										event.clientY < rect.top + rect.height / 2
									);
								}}
								onDrop={(event) => {
									event.preventDefault();
									event.stopPropagation();
									const rect = event.currentTarget.getBoundingClientRect();
									drag.onDrop(
										key,
										event.clientY < rect.top + rect.height / 2,
										event.dataTransfer.getData(TABS_DRAG_MIME) || undefined
									);
								}}
								onSelect={() => {
									onSelect(item.value);
									onClose();
								}}
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
									className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground active:cursor-grabbing"
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
										className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
	return (
		<DropdownMenu onOpenChange={(nextOpen) => setOpen(nextOpen)} open={open}>
			<DropdownMenuTrigger
				aria-hidden={!showTrigger}
				aria-label={
					moreCount > 0 ? `Show ${moreCount} more tabs` : "Show more tabs"
				}
				className={cn(
					tabsTriggerClassName,
					"flex-initial shrink-0 text-muted-foreground!",
					!showTrigger && "pointer-events-none invisible absolute"
				)}
				data-tabs-more-trigger="true"
				data-tabs-more-visible={showTrigger ? "true" : "false"}
				tabIndex={showTrigger ? undefined : -1}
			>
				<span className="max-w-24 truncate">
					{moreCount > 0 ? `${moreCount} more` : "More"}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80 rounded-xl p-0">
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
	const isDragOver = drag.dropTarget?.key === item.key;
	const originalProps = item.element.props;
	const originalOnDragStart = originalProps.onDragStart as
		| DragEventHandler<HTMLElement>
		| undefined;
	const originalOnDragEnd = originalProps.onDragEnd as
		| DragEventHandler<HTMLElement>
		| undefined;
	const originalOnDragOver = originalProps.onDragOver as
		| DragEventHandler<HTMLElement>
		| undefined;
	const originalOnDrop = originalProps.onDrop as
		| DragEventHandler<HTMLElement>
		| undefined;

	const managedTrigger = cloneElement(
		item.element as unknown as ReactElement<Record<string, unknown>>,
		{
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
			onDragEnd: (event: DragEvent<HTMLElement>) => {
				originalOnDragEnd?.(event);
				drag.onDragEnd();
			},
			onDragOver: (event: DragEvent<HTMLElement>) => {
				originalOnDragOver?.(event);
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				const rect = event.currentTarget.getBoundingClientRect();
				drag.onDragOver(
					item.key,
					event.clientX < rect.left + rect.width / 2,
					event.currentTarget
				);
			},
			onDragStart: (event: DragEvent<HTMLElement>) => {
				originalOnDragStart?.(event);
				if (event.defaultPrevented) {
					return;
				}
				drag.onDragStart(item.key, event);
			},
			onDrop: (event: DragEvent<HTMLElement>) => {
				originalOnDrop?.(event);
				event.preventDefault();
				event.stopPropagation();
				const rect = event.currentTarget.getBoundingClientRect();
				drag.onDrop(
					item.key,
					event.clientX < rect.left + rect.width / 2,
					event.dataTransfer.getData(TABS_DRAG_MIME) || undefined
				);
			},
		} as Record<string, unknown>
	);

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
	const available =
		(isVertical ? list.clientHeight : list.clientWidth) -
		paddingStart -
		paddingEnd;
	const moreSize =
		reserveMore && moreTrigger
			? isVertical
				? moreTrigger.getBoundingClientRect().height
				: moreTrigger.getBoundingClientRect().width
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
		if (fitted.length > 0 && nextUsed > availableForTabs) {
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
const TAB_OVERFLOW_CLOSE_DELAY_MS = 180;

interface TabsOverflowNavigationProps {
	children: ReactElement;
	edges: HorizontalOverflowEdges;
	onScrollPage: (direction: -1 | 1) => void;
}

function TabsOverflowNavigation({
	children,
	edges,
	onScrollPage,
}: TabsOverflowNavigationProps) {
	const [open, setOpen] = useState(false);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hasOverflow = edges.start || edges.end;

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current === null) {
			return;
		}
		clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);
	const openControls = useCallback(() => {
		cancelClose();
		setOpen(true);
	}, [cancelClose]);
	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimerRef.current = setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
		}, TAB_OVERFLOW_CLOSE_DELAY_MS);
	}, [cancelClose]);

	useEffect(() => {
		if (!hasOverflow) {
			setOpen(false);
		}
	}, [hasOverflow]);

	useEffect(() => {
		return cancelClose;
	}, [cancelClose]);

	return (
		<Popover
			modal={false}
			onOpenChange={(nextOpen) => {
				if (nextOpen) {
					openControls();
					return;
				}
				cancelClose();
				setOpen(false);
			}}
			open={open}
		>
			<PopoverAnchor asChild>
				<div
					className="group/tabs-overflow relative min-w-0"
					data-slot="tabs-list-overflow"
					onFocusCapture={openControls}
					onPointerEnter={openControls}
					onPointerLeave={scheduleClose}
				>
					{children}
					{hasOverflow ? (
						<PopoverTrigger
							aria-label="Open tab scroll controls"
							className="pointer-events-none absolute end-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 group-hover/tabs-overflow:pointer-events-auto group-hover/tabs-overflow:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100"
							data-slot="tabs-overflow-trigger"
							title="Scroll tabs"
							type="button"
						>
							<HugeiconsIcon
								aria-hidden
								className="size-3.5"
								icon={MoreHorizontalIcon}
								strokeWidth={2}
							/>
						</PopoverTrigger>
					) : null}
				</div>
			</PopoverAnchor>
			{hasOverflow ? (
				<PopoverContent
					align="end"
					className="w-auto gap-0 rounded-full p-1.5"
					data-slot="tabs-overflow-controls"
					initialFocus={false}
					onPointerEnter={openControls}
					onPointerLeave={scheduleClose}
					side="bottom"
					sideOffset={6}
				>
					<div className="flex items-center gap-1">
						<Button
							aria-label="Scroll tabs left"
							className="rounded-full"
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
							aria-label="Scroll tabs right"
							className="rounded-full"
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
				</PopoverContent>
			) : null}
		</Popover>
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
		variant = "default",
		...props
	},
	ref
) {
	const { activeValue, orientation, selectValue } = useTabsContext();
	const { items, staticChildren } = useMemo(
		() => getTabItems(children),
		[children]
	);
	const isScrollable = manageLayout === false && orientation === "horizontal";
	const nextItemKeys = items.map((item) => item.key);
	const itemKeysSignature = nextItemKeys.join("\u0000");
	const itemKeys = useMemo(() => nextItemKeys, [itemKeysSignature]);
	const generatedStorageId = useId();
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
	const listRef = useRef<HTMLDivElement | null>(null);
	const widthsRef = useRef(new Map<string, number>());
	const draggingKeyRef = useRef<string | null>(null);
	const loadedStorageKeyRef = useRef<string | null>(null);
	const composedListRef = useComposedRefs(listRef, ref);
	const overflowState = useHorizontalOverflowState(listRef, isScrollable);
	useEffect(() => {
		if (isScrollable) {
			overflowState.measure();
		}
	}, [isScrollable, itemKeysSignature, overflowState.measure]);

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
				const rect = trigger.getBoundingClientRect();
				widthsRef.current.set(
					key,
					orientation === "vertical" ? rect.height : rect.width
				);
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
		measureVersion,
		normalizedOrder,
		orientation,
		showMoreMenu,
	]);

	useEffect(() => {
		const list = listRef.current;
		if (!list || typeof ResizeObserver === "undefined") {
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
			onDragEnd: clearDrag,
			onDragOver: (key, before, element) => {
				const sourceKey = draggingKeyRef.current ?? draggingKey;
				if (!sourceKey || sourceKey === key) {
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
		}),
		[clearDrag, commitReorder, draggingKey, dropTarget, orientation]
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
			typeof window !== "undefined" &&
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
					tabsListVariants({ variant }),
					className,
					isScrollable &&
						"max-h-full max-w-full flex-nowrap justify-start overflow-x-auto overflow-y-hidden overscroll-x-contain [&>[data-slot=tabs-trigger]]:flex-none",
					isScrollable && HORIZONTAL_SCROLLBAR_HIDDEN
				)}
				data-edges={isScrollable ? overflowState.dataEdges : undefined}
				data-slot="tabs-list"
				data-tabs-overflow={isScrollable ? "true" : undefined}
				data-variant={variant}
				ref={composedListRef}
				style={
					isScrollable
						? { ...customStyle, ...overflowState.style }
						: customStyle
				}
				{...props}
			>
				{children}
			</TabsPrimitive.List>
		);
		if (!isScrollable) {
			return list;
		}
		return (
			<TabsOverflowNavigation
				edges={overflowState.edges}
				onScrollPage={scrollPage}
			>
				{list}
			</TabsOverflowNavigation>
		);
	}

	const displayedItems = displayedKeys
		.map((key) => itemByKey.get(key))
		.filter((item): item is TabItem => item !== undefined);
	return (
		<TabsPrimitive.List
			className={cn(
				tabsListVariants({ variant }),
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
			{inlineIndicator && (
				<span
					aria-hidden
					className="pointer-events-none absolute z-20 rounded-full bg-primary"
					data-tabs-drop-indicator="true"
					style={inlineIndicator}
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
		</TabsPrimitive.List>
	);
});

function TabsTrigger({
	children,
	className,
	...props
}: TabsPrimitive.Tab.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<TabsPrimitive.Tab
			className={cn(tabsTriggerClassName, className)}
			data-slot="tabs-trigger"
			{...props}
		>
			{localizedChildren}
		</TabsPrimitive.Tab>
	);
}

const tabsTriggerClassName = cn(
	"relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent! px-3 py-1 font-medium text-foreground/60 text-sm transition-all hover:text-foreground focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:rounded-2xl group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1.5 dark:text-muted-foreground dark:hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	"group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
	// The rule is the trigger's own `::before`, so the label sits under it
	// with no extra element. `whitespace-normal` because a three-word step
	// clipped to "Reserve your han…" in a narrow column loses the one
	// instruction it exists to give — the rules are what align the strip,
	// so a second line only makes it taller.
	"group-data-[variant=stepper]/tabs-list:h-auto group-data-[variant=stepper]/tabs-list:flex-col group-data-[variant=stepper]/tabs-list:items-start group-data-[variant=stepper]/tabs-list:gap-2 group-data-[variant=stepper]/tabs-list:whitespace-normal group-data-[variant=stepper]/tabs-list:rounded-sm group-data-[variant=stepper]/tabs-list:px-0 group-data-[variant=stepper]/tabs-list:py-0 group-data-[variant=stepper]/tabs-list:text-left group-data-[variant=stepper]/tabs-list:text-muted-foreground/60 group-data-[variant=stepper]/tabs-list:text-xs",
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
 * `t-tabs-indicator` class (globals.css) tweens left/top/width/height. Render
 * it as a child of ANY TabsList (`default` · `line` · `pills` · `segmented`) to
 * animate that variant's active marker; the trigger cedes its own active
 * background/underline to this element (see TabsTrigger). Its look adapts per
 * variant: a raised pill for default/segmented, a solid pill for pills, and a
 * bottom bar for line.
 */
function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
	return (
		<TabsPrimitive.Indicator
			className={cn(
				// default + segmented: the raised pill.
				"t-tabs-indicator z-0 rounded-full bg-background shadow-sm dark:bg-input/30",
				// pills: a solid black (light) / white (dark) pill, no shadow.
				"group-data-[variant^=pills]/tabs-list:bg-black group-data-[variant^=pills]/tabs-list:shadow-none dark:group-data-[variant^=pills]/tabs-list:bg-white",
				// line: a bottom bar instead of a filled pill.
				"group-data-vertical/tabs:group-data-[variant=line]/tabs-list:border-r-2 group-data-horizontal/tabs:group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-foreground group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:shadow-none",
				className
			)}
			data-slot="tabs-indicator"
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			className={cn("flex-1 text-sm outline-none", className)}
			data-slot="tabs-content"
			{...props}
		/>
	);
}

export {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
	tabsListVariants,
};
