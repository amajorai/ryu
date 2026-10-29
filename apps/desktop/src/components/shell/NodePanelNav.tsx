// apps/desktop/src/components/shell/NodePanelNav.tsx
//
// The iOS-Settings-style navigation behind the expanded node selector (the
// "Computer settings" dialog). The same layer components render in two
// surfaces:
//
//   - `menu`  — the compact node dropdown: every layer is a Base UI submenu.
//   - `panel` — the expanded dialog: every layer is a tappable row that PUSHES a
//               full-width subpage listing its options, with a back button.
//
// Subpages are rendered through a portal by the row that owns them, not
// snapshotted into a stack. The owning row stays mounted (lower pages are only
// `hidden`), so a pushed page keeps polling and re-rendering exactly like the
// submenu it replaces — a running engine flips to "stopped" in place instead of
// freezing at the moment it was opened.

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import {
	SettingsIconTile,
	type SettingsTint,
} from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { ItemGroup } from "@ryu/ui/components/item.tsx";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils.ts";
import styles from "./NodePanelNav.module.css";

export type NodeSurface = "menu" | "panel";

/** How long after a push/pop the second click of a double-click is dropped. */
const DOUBLE_CLICK_GUARD_MS = 600;

const NodeSurfaceContext = createContext<NodeSurface>("menu");

/** Which surface the node layers are rendering into. Defaults to the dropdown. */
export function useNodeSurface(): NodeSurface {
	return useContext(NodeSurfaceContext);
}

export interface PanelPage {
	id: string;
	title: string;
}

interface PanelNavValue {
	pop: () => void;
	push: (page: PanelPage) => void;
	registerSlot: (id: string, el: HTMLElement | null) => void;
	/** Drop `id` and everything pushed above it (its owner unmounted). */
	removeFrom: (id: string) => void;
	slots: ReadonlyMap<string, HTMLElement>;
	stack: readonly PanelPage[];
}

const PanelNavContext = createContext<PanelNavValue | null>(null);

function usePanelNav(): PanelNavValue {
	const nav = useContext(PanelNavContext);
	if (!nav) {
		throw new Error("Panel pages must be rendered inside NodePanelNav.");
	}
	return nav;
}

/** One page container. A stable ref callback per id keeps slot registration from
 *  re-firing (and re-rendering the provider) on every render. */
function PageSlot({ id, hidden }: { hidden: boolean; id: string }) {
	const { registerSlot } = usePanelNav();
	const ref = useCallback(
		(el: HTMLDivElement | null) => registerSlot(id, el),
		[id, registerSlot]
	);
	return <div className="space-y-5" hidden={hidden} ref={ref} />;
}

/**
 * The navigation stack. `root` is the top-level page; pushed pages render in
 * their own slots above it. The header (back button + title) is rendered by the
 * caller through `renderHeader`, so the dialog owns its own title semantics.
 */
export function NodePanelNav({
	bodyClassName,
	renderHeader,
	root,
}: {
	/** The scroll container around the pages (the header stays outside it). */
	bodyClassName?: string;
	renderHeader: (nav: {
		back: (() => void) | null;
		backLabel: string | null;
		title: string | null;
	}) => ReactNode;
	root: ReactNode;
}) {
	const [stack, setStack] = useState<PanelPage[]>([]);
	const [slots, setSlots] = useState<ReadonlyMap<string, HTMLElement>>(
		() => new Map()
	);

	const registerSlot = useCallback((id: string, el: HTMLElement | null) => {
		setSlots((current) => {
			if (el ? current.get(id) === el : !current.has(id)) {
				return current;
			}
			const next = new Map(current);
			if (el) {
				next.set(id, el);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);

	// Stable callbacks: `PanelPageLink` keys its unmount cleanup on `removeFrom`,
	// so a new identity per stack change would tear its own page down.
	// The row that opened each page, so popping back can return focus to it.
	const openers = useRef(new Map<string, HTMLElement>());
	const push = useCallback((page: PanelPage) => {
		const opener = document.activeElement;
		if (opener instanceof HTMLElement) {
			openers.current.set(page.id, opener);
		}
		setStack((current) =>
			current.some((p) => p.id === page.id) ? current : [...current, page]
		);
	}, []);
	const pop = useCallback(() => {
		setStack((current) => current.slice(0, -1));
	}, []);
	const removeFrom = useCallback((id: string) => {
		setStack((current) => {
			const index = current.findIndex((p) => p.id === id);
			return index === -1 ? current : current.slice(0, index);
		});
	}, []);

	const value = useMemo<PanelNavValue>(
		() => ({ stack, slots, registerSlot, push, pop, removeFrom }),
		[stack, slots, registerSlot, push, pop, removeFrom]
	);

	const top = stack.at(-1) ?? null;
	const below = stack.length > 1 ? stack.at(-2) : null;

	// Every push/pop lands at the top of the new page, like a navigation stack —
	// not wherever the previous page happened to be scrolled. Focus follows the
	// navigation: a push moves it to the back button (the page that held the
	// focused row is now hidden), a pop returns it to the row that opened the
	// page, so keyboard users never land on a hidden element.
	const frameRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const topId = top?.id ?? null;
	const previousTopId = useRef<string | null>(null);
	const navigatedAt = useRef(0);
	const depth = stack.length;
	const previousDepth = useRef(0);
	useEffect(() => {
		const poppedId = previousTopId.current;
		const pushed = depth > previousDepth.current;
		previousTopId.current = topId;
		previousDepth.current = depth;
		if (poppedId === topId) {
			return;
		}
		navigatedAt.current = performance.now();
		bodyRef.current?.scrollTo({ top: 0 });
		if (pushed) {
			frameRef.current
				?.querySelector<HTMLElement>('[data-slot="panel-back"]')
				?.focus();
			return;
		}
		const opener = poppedId ? openers.current.get(poppedId) : undefined;
		if (poppedId) {
			openers.current.delete(poppedId);
		}
		if (opener?.isConnected) {
			opener.focus();
		}
	}, [topId, depth]);

	return (
		<NodeSurfaceContext.Provider value="panel">
			<PanelNavContext.Provider value={value}>
				{/* `contents` keeps the header and body as direct flex children of the
				    dialog. The capture handler drops the rest of a double-click that
				    started on the previous page: a push swaps the page under the
				    pointer instantly, and the second click would otherwise land on
				    whatever row now sits there — often a Stop action. */}
				<div
					className="contents"
					onClickCapture={(event) => {
						if (
							event.detail > 1 &&
							performance.now() - navigatedAt.current < DOUBLE_CLICK_GUARD_MS
						) {
							event.preventDefault();
							event.stopPropagation();
						}
					}}
					ref={frameRef}
				>
					{renderHeader({
						back: top ? value.pop : null,
						backLabel: top ? (below?.title ?? "Computer") : null,
						title: top?.title ?? null,
					})}
					<div className={bodyClassName} ref={bodyRef}>
						<div className="space-y-5" hidden={top !== null}>
							{root}
						</div>
						{stack.map((page) => (
							<PageSlot
								hidden={page.id !== top?.id}
								id={page.id}
								key={page.id}
							/>
						))}
					</div>
				</div>
			</PanelNavContext.Provider>
		</NodeSurfaceContext.Provider>
	);
}

/** Back button for the panel header — App Settings' sub-page back button. */
export function PanelBackButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Button
			appearance="settings-back"
			aria-label={`Back to ${label}`}
			className="-ms-2 w-fit"
			data-slot="panel-back"
			onClick={onClick}
			size="sm"
			variant="ghost-muted"
		>
			<HugeiconsIcon className="size-4 rtl:rotate-180" icon={ArrowLeft01Icon} />
			<span className="max-w-40 truncate" title={label}>
				{label}
			</span>
		</Button>
	);
}

/**
 * One settings section — the same `SettingsSection` header/caption and
 * `settings-group` card the App Settings screens use, so the dialog reads as
 * part of Settings rather than a lookalike.
 */
export function PanelSection({
	children,
	footer,
	title,
	trailing,
}: {
	children: ReactNode;
	footer?: ReactNode;
	title?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<SettingsSection caption={footer} headerAction={trailing} title={title}>
			<PanelGroup>{children}</PanelGroup>
		</SettingsSection>
	);
}

/**
 * The grouped card: Settings' `settings-group` surface, with inset hairlines
 * between rows (see `NodePanelNav.module.css`). An empty card collapses.
 */
export function PanelGroup({ children }: { children: ReactNode }) {
	return (
		<ItemGroup
			appearance="settings-group"
			className={cn("overflow-hidden empty:hidden", styles.group)}
			spacing="flush"
		>
			{children}
		</ItemGroup>
	);
}

/**
 * Settings rows are `SettingsItem`s; ours add one stretched button so the whole
 * row is the click target (the same overlay trick as `SettingsNavRow`), and
 * let the item title fill the row so a value can sit right-aligned in it.
 */
const ROW_ITEM_CLASS =
	"relative focus-within:bg-foreground/5 [&_[data-slot=item-title]]:w-full";

type RowTone = "default" | "destructive" | "warning" | "accent";

const TONE_TEXT = {
	default: undefined,
	destructive: "text-status-destructive",
	warning: "text-status-warning",
	accent: "text-primary",
} satisfies Record<RowTone, string | undefined>;

/** The tinted Settings tile, tagged so the card's hairlines can start past it. */
export function PanelRowIcon({
	icon,
	tint = "gray",
}: {
	icon: IconSvgElement;
	tint?: SettingsTint;
}) {
	return (
		<span className="contents" data-slot="settings-icon-tile">
			<SettingsIconTile icon={icon} tint={tint} />
		</span>
	);
}

/** Muted right-hand value, iOS-style ("All running", "llama.cpp", a URL). */
function RowValue({ children }: { children: ReactNode }) {
	return (
		<span
			className="flex min-w-0 max-w-[55%] shrink items-center justify-end gap-1.5 font-normal text-muted-foreground text-sm"
			title={typeof children === "string" ? children : undefined}
		>
			{typeof children === "string" ? (
				<span className="truncate">{children}</span>
			) : (
				children
			)}
		</span>
	);
}

function Chevron() {
	return (
		<HugeiconsIcon
			aria-hidden
			className="size-4 shrink-0 text-muted-foreground/70 rtl:rotate-180"
			icon={ArrowRight01Icon}
		/>
	);
}

/** A tappable settings row: tile, title, value, trailing mark. */
export function PanelRow({
	children,
	className,
	current,
	disabled,
	icon,
	onClick,
	pressed,
	sideAction,
	tint,
	tone = "default",
	trailing,
	value,
}: {
	children: ReactNode;
	className?: string;
	/** The selected choice in a pick-one list (`aria-current`). */
	current?: boolean;
	/** Settings caption for this row. Read by an enclosing `SettingsGroup`,
	 *  which renders it under the card; the row itself never prints it. */
	description?: ReactNode;
	disabled?: boolean;
	icon?: IconSvgElement;
	onClick?: () => void;
	/** On/off state of an independent toggle row (`aria-pressed`). */
	pressed?: boolean;
	/** A second control beside the row (share, uninstall) — never nested in it. */
	sideAction?: ReactNode;
	tint?: SettingsTint;
	tone?: RowTone;
	/** A mark after the value: the selection tick, a busy label. */
	trailing?: ReactNode;
	value?: ReactNode;
}) {
	return (
		<SettingsItem
			actions={sideAction}
			className={cn(ROW_ITEM_CLASS, disabled && "opacity-50", className)}
			navigation={!disabled}
			title={
				<button
					aria-current={current ? "true" : undefined}
					aria-pressed={pressed}
					className={cn(
						"flex w-full min-w-0 items-center gap-2.5 text-start outline-none disabled:cursor-default",
						TONE_TEXT[tone]
					)}
					disabled={disabled}
					onClick={onClick}
					type="button"
				>
					{icon ? <PanelRowIcon icon={icon} tint={tint} /> : null}
					<span
						className="min-w-0 flex-1 truncate"
						title={typeof children === "string" ? children : undefined}
					>
						{children}
					</span>
					{value === undefined || value === null ? null : (
						<RowValue>{value}</RowValue>
					)}
					{trailing}
					<span aria-hidden="true" className="absolute inset-0" />
				</button>
			}
		/>
	);
}

/** A non-interactive row (the current state at the top of a layer page). */
export function PanelStaticRow({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<SettingsItem
			className={className}
			title={
				<span className="flex w-full min-w-0 items-center gap-2.5">
					{children}
				</span>
			}
		/>
	);
}

/**
 * A row that pushes a subpage — `SettingsNavRow`'s tile, title, value and
 * chevron. `children` is the page body; it only mounts while the page is on the
 * stack, and renders through a portal from HERE so it stays live.
 */
export function PanelPageLink({
	children,
	disabled,
	icon,
	label,
	tint,
	title,
	trailing,
}: {
	children: ReactNode;
	disabled?: boolean;
	icon?: IconSvgElement;
	label: ReactNode;
	tint?: SettingsTint;
	/** Page title; defaults to `label` when that is a plain string. */
	title?: string;
	/** The row's current value, shown muted before the chevron. */
	trailing?: ReactNode;
}) {
	const id = useId();
	const { push, removeFrom, slots, stack } = usePanelNav();
	const open = stack.some((page) => page.id === id);
	const slot = open ? slots.get(id) : undefined;
	const pageTitle = title ?? (typeof label === "string" ? label : "Details");

	// An owner that disappears (the layer it describes was uninstalled, the
	// section stopped rendering) takes its page — and anything above it — along.
	useEffect(() => () => removeFrom(id), [id, removeFrom]);

	return (
		<>
			<SettingsItem
				className={cn(ROW_ITEM_CLASS, disabled && "opacity-50")}
				navigation={!disabled}
				title={
					<button
						className="flex w-full min-w-0 items-center gap-2.5 text-start outline-none disabled:cursor-default"
						disabled={disabled}
						onClick={() => push({ id, title: pageTitle })}
						type="button"
					>
						{icon ? <PanelRowIcon icon={icon} tint={tint} /> : null}
						<span
							className="min-w-0 flex-1 truncate"
							title={typeof label === "string" ? label : undefined}
						>
							{label}
						</span>
						{trailing ? <RowValue>{trailing}</RowValue> : null}
						<Chevron />
						<span aria-hidden="true" className="absolute inset-0" />
					</button>
				}
			/>
			{slot ? createPortal(children, slot) : null}
		</>
	);
}
