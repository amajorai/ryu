import {
	Cancel01Icon,
	type ComputerTerminal01Icon,
	File01Icon,
	PinIcon,
	PinOffIcon,
	PlugSocketIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Icon,
	type PanelIconPresentation,
	panelIconPresentationClasses,
} from "@ryu/ui/components/icon.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { OverflowTooltip } from "@/src/components/layout/overflow-tooltip.tsx";
import { isPinnableDockTabKind } from "@/src/components/panels/dock-panels.ts";
import { SubagentAvatar } from "@/src/components/panels/subagent-identity.tsx";
import type { PanelTab, TabKind, TabTypeDef } from "./tab-model.ts";

/** How a tab's glyph is drawn: a subagent's generative avatar (the tab shows ONE
 *  identity, so a shared robot glyph tells the user nothing), a bundled
 *  Hugeicons element (built-in + `native` panels — no network, identical to
 *  before), or a contributed icon id resolved through the shared `Icon`
 *  (third-party panels). */
export interface TabIconSpec {
	glyph?: typeof ComputerTerminal01Icon;
	iconId?: string;
	/** A subagent id — drawn as that subagent's own dither avatar. */
	seed?: string;
}

export function TabIcon({
	className,
	presentation,
	size = 12,
	spec,
}: {
	className?: string;
	presentation?: PanelIconPresentation;
	/** Edge length in px for a contributed (masked SVG) icon — it needs an
	 *  explicit box, unlike a Hugeicons element sized by `className`. */
	size?: number;
	spec: TabIconSpec;
}) {
	if (spec.seed) {
		// `animate={false}`: the strip remounts this on every tab change, and the
		// avatar's stock 600ms entrance would replay each time.
		return (
			<SubagentAvatar
				animate={false}
				className={className}
				presentation={presentation}
				seed={spec.seed}
			/>
		);
	}
	if (spec.glyph) {
		return (
			<HugeiconsIcon
				className={cn(panelIconPresentationClasses(presentation), className)}
				icon={spec.glyph}
			/>
		);
	}
	if (spec.iconId) {
		return (
			<Icon
				className={className}
				icon={spec.iconId}
				presentation={presentation}
				size={size}
			/>
		);
	}
	// A contributed panel that declared no icon: the generic plugin glyph, so the
	// tab still reads as "an app's panel" rather than as a built-in.
	return (
		<HugeiconsIcon
			className={cn(panelIconPresentationClasses(presentation), className)}
			icon={PlugSocketIcon}
		/>
	);
}

/** The icon of a tab TYPE (the "+" menu / launchpad cards). */
export function tabTypeIcon(def: TabTypeDef): TabIconSpec {
	return { glyph: def.icon, iconId: def.iconId };
}

interface PanelTabBarProps {
	activeUid: string;
	addTypes: TabTypeDef[];
	/** Resolve an OPEN tab's icon. Open tabs include kinds absent from `addTypes`
	 *  (cowork/subagent/artifact/inspector are opened programmatically, and a
	 *  contributed tab outlives a brief contributions outage), so the strip cannot
	 *  derive the glyph from the add-menu alone. */
	iconForKind: (kind: TabKind) => TabIconSpec;
	onActivate: (uid: string) => void;
	onAdd: (kind: TabKind) => void;
	onCloseAll: () => void;
	onCloseOthers: (uid: string) => void;
	onClosePanel: () => void;
	onCloseTab: (uid: string) => void;
	// Move a tab to the sibling dock (right ⇄ bottom). Omitted if there is no
	// sibling to move to.
	onMoveToOtherPanel?: (uid: string) => void;
	/** Pin/unpin a project-shareable tab. Omitted when the dock has no project folder. */
	onTogglePin?: (uid: string) => void;
	otherPanelIcon: typeof Cancel01Icon;
	otherPanelLabel: string;
	/** Main-tab PAGES offered under a "Pages" submenu of "+". Separate from
	 *  `addTypes` because that list also feeds the launchpad's cards, where a long
	 *  page list would bury the dock's own panels. Omitted = no submenu. */
	pageTypes?: TabTypeDef[];
	/** When set, pin is offered but disabled (e.g. no project folder open). */
	pinDisabledReason?: string;
	tabs: PanelTab[];
}

export function PanelTabBar({
	tabs,
	activeUid,
	onActivate,
	onCloseTab,
	onCloseOthers,
	onCloseAll,
	onMoveToOtherPanel,
	onTogglePin,
	pinDisabledReason,
	otherPanelIcon,
	otherPanelLabel,
	onAdd,
	addTypes,
	pageTypes,
	iconForKind,
	onClosePanel,
}: PanelTabBarProps) {
	const tl = useLiteralMessages();
	return (
		// Floating rounded-pill strip, matching the main window tab bar (gap between
		// pills, no attached underline). The dock card already provides the floating
		// surface, so the strip itself is transparent.
		<div className="flex shrink-0 items-center gap-1 bg-sidebar px-1.5 py-1.5">
			{tabs.map((tab) => {
				const canPin =
					Boolean(onTogglePin) &&
					tab.kind !== "unavailable" &&
					isPinnableDockTabKind(tab.kind);
				const pinBlocked = Boolean(pinDisabledReason);
				return (
					<ContextMenu key={tab.uid}>
						<ContextMenuTrigger className="flex h-8 max-w-[180px] shrink-0 items-center">
							{/* custom tab interaction, mirrors the window tab bar */}
							<div
								className={cn(
									"group/tab relative flex h-8 w-full min-w-0 items-center rounded-full transition-colors",
									activeUid === tab.uid ? "bg-muted" : "hover:bg-muted/50"
								)}
								data-active={activeUid === tab.uid}
								// Middle-click closes the tab, exactly like the window tabs.
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										onCloseTab(tab.uid);
									}
								}}
							>
								{/* Icon zone — the kind icon morphs into a close X on tab hover. */}
								<button
									aria-label="Close tab"
									className={cn(
										"relative ml-2 flex size-4 shrink-0 items-center justify-center rounded-full",
										activeUid === tab.uid
											? "text-muted-foreground"
											: "text-muted-foreground/70"
									)}
									onClick={() => onCloseTab(tab.uid)}
									type="button"
								>
									<TabIcon
										className="absolute size-3"
										presentation="panel-tab"
										spec={iconForKind(tab.kind)}
									/>
									<HugeiconsIcon
										className="absolute size-3.5 scale-50 opacity-0 transition-[opacity,scale] duration-150 group-focus-within/tab:scale-100 group-focus-within/tab:opacity-100 group-hover/tab:scale-100 group-hover/tab:opacity-100"
										icon={Cancel01Icon}
									/>
								</button>
								{/* Title — activates the tab. */}
								<button
									className={cn(
										"flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden pr-3 pl-1.5",
										activeUid === tab.uid
											? "text-foreground"
											: "text-muted-foreground"
									)}
									onClick={() => onActivate(tab.uid)}
									type="button"
								>
									{tab.pinned ? (
										<Tooltip>
											<TooltipTrigger
												render={
													<span className="flex shrink-0 items-center">
														<HugeiconsIcon
															className="size-3.5 text-muted-foreground"
															icon={PinIcon}
														/>
													</span>
												}
											/>
											<TooltipContent>
												Shared across chats in this project
											</TooltipContent>
										</Tooltip>
									) : null}
									<OverflowTooltip
										className="min-w-0 overflow-hidden whitespace-nowrap font-medium text-xs leading-none"
										fade
										text={tab.label}
									/>
								</button>
							</div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							{canPin ? (
								<>
									<ContextMenuItem
										disabled={pinBlocked}
										onClick={() => onTogglePin?.(tab.uid)}
									>
										<HugeiconsIcon
											className="size-4"
											icon={tab.pinned ? PinOffIcon : PinIcon}
										/>
										{tab.pinned ? "Unpin tab" : "Pin tab"}
									</ContextMenuItem>
									{tab.pinned ? (
										<div className="px-2 pb-1.5 text-muted-foreground text-xs leading-snug">
											Shared across chats in this project
										</div>
									) : pinDisabledReason ? (
										<div className="px-2 pb-1.5 text-muted-foreground text-xs leading-snug">
											{pinDisabledReason}
										</div>
									) : (
										<div className="px-2 pb-1.5 text-muted-foreground text-xs leading-snug">
											Share this tab across all chats in the project
										</div>
									)}
									<ContextMenuSeparator />
								</>
							) : null}
							<ContextMenuItem onClick={() => onCloseTab(tab.uid)}>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
								Close
							</ContextMenuItem>
							<ContextMenuItem
								disabled={tabs.length <= 1}
								onClick={() => onCloseOthers(tab.uid)}
							>
								Close others
							</ContextMenuItem>
							<ContextMenuItem onClick={onCloseAll}>Close all</ContextMenuItem>
							{onMoveToOtherPanel && (
								<>
									<ContextMenuSeparator />
									<ContextMenuItem onClick={() => onMoveToOtherPanel(tab.uid)}>
										<HugeiconsIcon className="size-4" icon={otherPanelIcon} />
										{tl("Move to {otherPanelLabel}", { otherPanelLabel })}
									</ContextMenuItem>
								</>
							)}
						</ContextMenuContent>
					</ContextMenu>
				);
			})}

			{/* Add tab button + dropdown */}
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="New tab"
					className="ml-0.5 flex size-7 items-center justify-center"
					variant="panel-action"
				>
					<HugeiconsIcon className="size-3.5" icon={PlusSignIcon} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="bottom">
					{addTypes.map((t) => (
						<DropdownMenuItem
							density="compact"
							key={t.kind}
							onClick={() => onAdd(t.kind)}
							spacing="spacious"
						>
							<TabIcon
								className="size-3.5 shrink-0"
								size={14}
								spec={tabTypeIcon(t)}
							/>
							{t.label}
						</DropdownMenuItem>
					))}
					{pageTypes && pageTypes.length > 0 ? (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger density="compact" spacing="spacious">
								<HugeiconsIcon
									className="size-3.5 shrink-0"
									icon={File01Icon}
								/>
								Pages
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{pageTypes.map((t) => (
									<DropdownMenuItem
										density="compact"
										key={t.kind}
										onClick={() => onAdd(t.kind)}
										spacing="spacious"
									>
										<TabIcon
											className="size-3.5 shrink-0"
											size={14}
											spec={tabTypeIcon(t)}
										/>
										{t.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>

			<div className="flex-1" />

			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-label="Close panel"
							className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
							onClick={onClosePanel}
							type="button"
						>
							<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
						</button>
					}
				/>
				<TooltipContent>Close panel</TooltipContent>
			</Tooltip>
		</div>
	);
}

// ── Empty panel state (launchpad) ─────────────────────────────────────────────

// Shown when a panel has zero open tabs — the same launchpad idea as the no-tabs
// home page (EmptyTabsState): rather than a bare placeholder, offer the openable
// tab types as quick-action cards. The cards wrap, so this reads well both in the
// narrow right dock (cards stack) and the short-wide bottom dock (cards sit in a
// row). `addTypes` is the same list that feeds the "+" menu, so the two stay in
// sync automatically.
export function PanelEmptyState({
	addTypes,
	onAdd,
}: {
	addTypes: TabTypeDef[];
	onAdd: (kind: TabKind) => void;
}) {
	return (
		<div className="flex h-full w-full items-center justify-center overflow-auto p-6">
			<div className="flex flex-col items-center gap-4">
				<p className="text-center text-muted-foreground text-xs">
					No tabs open. Open one to get started.
				</p>
				<div className="flex flex-wrap items-stretch justify-center gap-2">
					{addTypes.map((t) => (
						<button
							className="group flex w-36 flex-col justify-between gap-3 rounded-xl bg-muted/50 p-3 text-left transition-colors hover:bg-muted/70"
							key={t.kind}
							onClick={() => onAdd(t.kind)}
							type="button"
						>
							<TabIcon
								className="size-5 shrink-0"
								presentation="panel-launchpad"
								size={20}
								spec={tabTypeIcon(t)}
							/>
							<span
								className="truncate font-medium text-foreground text-sm"
								title={t.label}
							>
								{t.label}
							</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
