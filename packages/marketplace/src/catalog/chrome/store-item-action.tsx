// packages/marketplace/src/catalog/chrome/store-item-action.tsx
//
// The one Store action control every catalog card + detail header uses, so the
// affordance is identical across Apps, Plugins, Models, Skills, MCP, and Agents.
// It is the generalization of the models page's morph button:
//
//   • not installed          → a "Get" button (with live download %), wrapped
//                              in a right-click ContextMenu.
//   • installed, un-removable → the shared "built in" status glyph (+ the menu).
//   • installed, no enable    → 3-dot menu with Remove (+ Report).
//   • installed + enabled     → 3-dot menu with Disable, Report, Remove.
//   • installed + disabled    → 3-dot menu with Enable, Report, Remove.
//
// The user-facing verb is Get / Installing… / Installed / Remove. The PROPS keep the
// install vocabulary (`installed`, `onInstall`, `onUninstall`) deliberately:
// that is what the lifecycle is called everywhere from Core outwards, and
// renaming the wire to match the copy would make the two halves harder to trace,
// not easier.
//
// Sections without an enable/disable concept (Models per-file, Agents, MCP) pass
// `enabled={undefined}`; sections that have one (Apps, Skills) pass a boolean.
//
// The menu also carries **Settings** whenever the surface can resolve where the
// item is configured (`onOpenSettings`). That is the only route from a listing to
// its own credentials/config: a user looking for "where do I paste my Exa API
// key?" starts on the card they just installed, not in a settings dialog they
// have to guess the tab of. A surface with no settings destination (web, or an
// item that declares none) passes nothing and the row does not render.
//
// `extra` appends surface-supplied rows to that same menu. It exists so a
// surface can make the "…" UNIVERSAL: Settings is desktop-only and Report is
// meaningless on a first-party curated entry, so a store relying on those two
// alone shows the menu on some cards and not others, and the grid stops reading
// as one component. The web store passes "Copy link", which every listing has.

import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	Delete01Icon,
	Download04Icon,
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import { Fragment, useState } from "react";
import { useOptionalReport } from "../../report/report-provider.tsx";
import type { ReportTarget } from "../../report/types.ts";
import type { PublisherHealthInput } from "../detail/publisher-health.ts";
import { PublisherHealthCard } from "../detail/publisher-health-card.tsx";

export interface StoreItemActionProps {
	/** Rendered instead of the lifecycle buttons on a read-only surface (web). */
	affordance?: React.ReactNode;
	/** A lifecycle call is in flight — the control shows a spinner and disables. */
	busy?: boolean;
	className?: string;
	/** Overrides the "Disable" menu label (e.g. Engines' "Stop"). */
	disableLabel?: string;
	/** Public release-asset download total. While an item is not installed, the
	 * primary CTA shows this social proof and reveals the Get verb on hover/focus. */
	downloadCount?: number | null;
	/** `undefined` = the item has no enable/disable concept (install/uninstall only). */
	enabled?: boolean;
	/** Overrides the "Enable" menu label (e.g. Engines' "Set as active"). */
	enableLabel?: string;
	/** Extra rows for the overflow menu, appended after the built-in ones. The
	 *  read-only web store uses it for "Copy link", which is what lets EVERY card
	 *  carry the "…" — Settings and Report are both surface- or listing-specific,
	 *  so without a universal row the menu appeared on some cards and not others
	 *  and the grid read as two different components again. Its presence counts
	 *  toward whether the menu renders at all. */
	extra?: React.ReactNode;
	/** Non-null when this node does not meet the listing's declared host floors
	 *  (`engines`) — the string is the user-facing reason, e.g.
	 *  `"Requires Ryu >=0.2.0 (you have 0.1.12)"`, from `describeIncompatibility`.
	 *
	 *  The listing is still SHOWN: it used to vanish entirely, which left a user
	 *  unable to discover that updating would bring it back. Instead the install
	 *  verb is withheld and replaced by a disabled "Unavailable" pill carrying the
	 *  reason, because Core refuses the install anyway — offering an Add button
	 *  that is guaranteed to 409 is worse than not offering one.
	 *
	 *  Pass only for BLOCKING failures. A floor against a surface nobody can
	 *  observe is advisory, and greying a card over it would hide listings for no
	 *  reason — `describeIncompatibility` already returns null in that case. */
	incompatible?: string | null;
	installed: boolean;
	/** Locked items (e.g. the flagship agent) can't be removed. */
	locked?: boolean;
	lockedLabel?: string;
	onDisable?: () => void;
	onEnable?: () => void;
	onInstall?: () => void;
	/** Reveal this item's own settings (host's settings dialog, at its tab).
	 *  Omitted when the surface has no settings destination for it. */
	onOpenSettings?: () => void;
	/** Explicit report handler; falls back to ReportProvider + reportTarget. */
	onReport?: () => void;
	onUninstall?: () => void;
	/** Live install completion 0–100 (or null when the size is unknown). */
	percent?: number | null;
	publisherHealth?: Omit<PublisherHealthInput, "publisherTrust">;
	/** Server-derived publisher identity mark. Dotted publishers require the
	 * two-step community install disclosure below. */
	publisherTrust?: PublisherTrustLevel | null;
	/** Identity passed to the shared ReportProvider when onReport is omitted. */
	reportTarget?: ReportTarget;
}

export interface PublisherInstallDisclosureProps {
	onInstall: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	publisherHealth?: Omit<PublisherHealthInput, "publisherTrust">;
	publisherTrust: PublisherTrustLevel;
}

/** The shared two-step disclosure for a publisher without identity verification. */
export function PublisherInstallDisclosure({
	onInstall,
	onOpenChange,
	open,
	publisherHealth,
	publisherTrust,
}: PublisherInstallDisclosureProps) {
	const [step, setStep] = useState<"review" | "confirm">("review");
	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			setStep("review");
		}
		onOpenChange(nextOpen);
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{step === "review"
							? "This publisher is not verified"
							: "Install community package?"}
					</DialogTitle>
					<DialogDescription>
						{step === "review"
							? "Anyone can publish a community package. Ryu has not verified this publisher's identity."
							: "This package is from a publisher without verified identity. You are responsible for reviewing the source and requested access."}
					</DialogDescription>
				</DialogHeader>
				{step === "review" ? (
					<PublisherHealthCard
						publisherTrust={publisherTrust}
						{...publisherHealth}
					/>
				) : (
					<div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
						<p className="font-medium">Review the source before continuing.</p>
						<p className="mt-1 text-muted-foreground">
							The health score is only a summary of reported signals and is not
							a guarantee of safety.
						</p>
					</div>
				)}
				<DialogFooter>
					{step === "review" ? (
						<Button onClick={() => setStep("confirm")} variant="secondary">
							Review risk and continue
						</Button>
					) : (
						<Button
							onClick={() => {
								handleOpenChange(false);
								onInstall();
							}}
							variant="destructive"
						>
							I understand the risk — install
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export default function StoreItemAction({
	installed,
	enabled,
	busy = false,
	percent = null,
	locked = false,
	lockedLabel = "Built in",
	onInstall,
	onUninstall,
	onEnable,
	onDisable,
	onOpenSettings,
	onReport,
	reportTarget,
	affordance,
	className,
	extra,
	enableLabel = "Enable",
	disableLabel = "Disable",
	downloadCount = null,
	incompatible = null,
	publisherTrust = null,
	publisherHealth,
}: StoreItemActionProps) {
	const [communityDialogOpen, setCommunityDialogOpen] = useState(false);
	const reportCtx = useOptionalReport();
	const canReport = Boolean(onReport || (reportCtx && reportTarget));
	const handleReport = () => {
		if (onReport) {
			onReport();
			return;
		}
		if (reportCtx && reportTarget) {
			reportCtx.open(reportTarget);
		}
	};
	const needsCommunityDisclosure =
		publisherTrust === "dotted" && Boolean(onInstall);
	const handleInstall = () => {
		if (needsCommunityDisclosure) {
			setCommunityDialogOpen(true);
			return;
		}
		onInstall?.();
	};
	const communityDisclosure = needsCommunityDisclosure ? (
		<PublisherInstallDisclosure
			onInstall={() => onInstall?.()}
			onOpenChange={setCommunityDialogOpen}
			open={communityDialogOpen}
			publisherHealth={publisherHealth}
			publisherTrust={publisherTrust ?? "dotted"}
		/>
	) : null;

	// Whether the trailing overflow menu has anything to hold at all. Both the
	// read-only-affordance and the locked paths render a static primary control, so
	// Settings/Report can only reach the user through that menu.
	const hasOverflow = canReport || Boolean(onOpenSettings) || Boolean(extra);
	const overflow = (
		<StoreItemOverflowMenu
			className={className}
			extra={extra}
			onOpenSettings={onOpenSettings}
			onReport={canReport ? handleReport : undefined}
		/>
	);

	if (affordance) {
		if (!hasOverflow) {
			return (
				<>
					{affordance}
					{communityDisclosure}
				</>
			);
		}
		return (
			<>
				<div className="flex items-center gap-0.5">
					{affordance}
					{overflow}
				</div>
				{communityDisclosure}
			</>
		);
	}

	// Host floors are unmet on this node. Checked BEFORE every lifecycle branch
	// below, because each of them offers a verb Core will refuse: Get and Enable
	// both 409, and Enable in particular would read as "this is one click from
	// working" when it is not. Remove stays available for an item already on disk.
	if (incompatible) {
		// The pill label stays short ("Unavailable") because this control sits in a
		// dense card row across six sections, but the REASON must not be
		// hover-only: `title` alone is unreachable by keyboard and invisible on
		// touch, which is most of the surfaces this renders on. `aria-label` carries
		// the full sentence to assistive tech and matches how the sibling "Built in"
		// glyph exposes its own text.
		const pill = (
			<Button
				aria-label={incompatible}
				className={className}
				disabled
				size="sm"
				title={incompatible}
				variant="secondary"
			>
				<HugeiconsIcon
					className="size-3.5 text-muted-foreground"
					icon={Alert02Icon}
				/>
				Unavailable
			</Button>
		);
		if (!installed) {
			return hasOverflow ? (
				<div className="flex items-center gap-0.5">
					{pill}
					{overflow}
				</div>
			) : (
				pill
			);
		}
		// Installed but held back. `hasEnableConcept={false}` so the menu offers no
		// Enable — the plugin cannot run here, and the only useful verbs are Remove
		// plus whatever Settings/Report the surface supplies.
		return (
			<div className="flex items-center gap-0.5">
				{pill}
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label="Manage"
								className={className}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						<StoreItemMenuItems
							canReport={canReport}
							hasEnableConcept={false}
							isEnabled={false}
							onOpenSettings={onOpenSettings}
							onReport={handleReport}
							onUninstall={locked ? undefined : onUninstall}
						/>
						{extra}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	}

	if (!installed) {
		const hasDownloadCount =
			typeof downloadCount === "number" &&
			Number.isFinite(downloadCount) &&
			downloadCount > 0;
		const idleLabel = hasDownloadCount
			? formatDownloadCount(downloadCount)
			: null;
		return (
			<ContextMenu>
				<ContextMenuTrigger
					className={className}
					render={<div className="flex items-center" />}
				>
					<InstallProgressButton
						aria-label={idleLabel ? `Get — ${idleLabel} downloads` : "Get"}
						className={idleLabel ? "group" : undefined}
						idleVariant="default"
						installing={busy}
						onClick={handleInstall}
						percent={percent}
					>
						{idleLabel ? (
							<>
								<HugeiconsIcon className="size-4" icon={Download04Icon} />
								<span className="group-hover:hidden group-focus-visible:hidden">
									{idleLabel}
								</span>
								<span className="hidden group-hover:inline group-focus-visible:inline">
									Get
								</span>
							</>
						) : (
							"Get"
						)}
					</InstallProgressButton>
				</ContextMenuTrigger>
				<ContextMenuContent align="end">
					<ContextMenuItem onClick={handleInstall}>
						<HugeiconsIcon className="size-4" icon={Download04Icon} />
						Get
					</ContextMenuItem>
					{canReport ? (
						<>
							<ContextMenuSeparator />
							<ContextMenuItem onClick={handleReport}>
								<HugeiconsIcon className="size-4" icon={Alert02Icon} />
								Report
							</ContextMenuItem>
						</>
					) : null}
				</ContextMenuContent>
			</ContextMenu>
		);
	}

	if (locked) {
		// Locked = built-in / un-removable. It has no lifecycle verbs, but it is
		// exactly the kind of item that DOES have settings, so the overflow menu
		// still renders whenever there is something behind it.
		//
		// This used to be a disabled `<Button>` reading "Built in". A disabled button
		// is an affordance that says "you could press this, but not now", and there
		// is no now — the item can never be removed. It is a STATE, so it renders as
		// the shared status glyph, with the word on hover. That also stops the widest
		// control in a grid of listing rows being the one row you cannot act on.
		const mark = <StatusBadge kind="builtin" label={lockedLabel} />;
		if (!hasOverflow) {
			return <span className={className}>{mark}</span>;
		}
		return (
			<div className="flex items-center gap-0.5">
				{mark}
				{overflow}
			</div>
		);
	}

	// Installed items keep a visible completion state, while the lifecycle actions
	// (enable/disable + uninstall) live behind one deliberate click. `enabled === undefined` means
	// the item has no enable/disable concept (Models per-file, Agents, MCP, and
	// Skills whose CLI can't toggle) — the menu then holds only Uninstall (+ Report).
	const hasEnableConcept = enabled !== undefined;
	const isEnabled = enabled === true;

	// While a lifecycle call is in flight the trigger shows a spinner and locks,
	// so a second click can't race the first.
	if (busy) {
		return (
			<Button
				aria-label="Working…"
				className={className}
				loading
				size="icon-sm"
				variant="ghost"
			/>
		);
	}

	return (
		<div className="flex items-center gap-0.5">
			<Button
				aria-label="Installed"
				className={className}
				disabled
				size="sm"
				variant="secondary"
			>
				<HugeiconsIcon
					className="size-3.5 text-emerald-500"
					icon={CheckmarkCircle02Icon}
				/>
				Installed
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="Manage"
							className={className}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					<StoreItemMenuItems
						canReport={canReport}
						disableLabel={disableLabel}
						enableLabel={enableLabel}
						hasEnableConcept={hasEnableConcept}
						isEnabled={isEnabled}
						onDisable={onDisable}
						onEnable={onEnable}
						onOpenSettings={onOpenSettings}
						onReport={handleReport}
						onUninstall={onUninstall}
					/>
					{extra}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** Shared marketplace count policy: 12,400 → 12,400, 1,200,000 → 1.2m. */
function formatDownloadCount(count: number): string {
	return formatCount(count) ?? "—";
}

/**
 * Shared menu items used by both the installed DropdownMenu and the
 * not-installed ContextMenu. Renders Settings, the Enable/Disable toggle,
 * Report, and Remove — each conditionally.
 */
function StoreItemMenuItems({
	hasEnableConcept,
	isEnabled,
	canReport,
	onEnable,
	onDisable,
	onOpenSettings,
	onReport,
	onUninstall,
	enableLabel = "Enable",
	disableLabel = "Disable",
}: {
	canReport: boolean;
	disableLabel?: string;
	enableLabel?: string;
	hasEnableConcept: boolean;
	isEnabled: boolean;
	onDisable?: () => void;
	onEnable?: () => void;
	onOpenSettings?: () => void;
	onReport: () => void;
	onUninstall?: () => void;
}) {
	// Whether a toggle row actually renders — an enable concept with no handler for
	// the CURRENT direction renders nothing, so the separator must not assume one.
	const hasToggleItem =
		hasEnableConcept && Boolean(isEnabled ? onDisable : onEnable);
	return (
		<>
			{/* Settings leads the menu: it is the reason a user opens it on an item
			    that is already installed and working. */}
			{onOpenSettings ? (
				<DropdownMenuItem onClick={onOpenSettings}>
					<HugeiconsIcon className="size-4" icon={Settings01Icon} />
					Settings
				</DropdownMenuItem>
			) : null}
			{hasEnableConcept &&
				(isEnabled ? (
					// A one-way toggle (an Engines "Text" row can be SWAPPED to, never
					// switched off) passes no `onDisable` — render nothing rather than a
					// menu entry that does nothing when clicked.
					onDisable ? (
						<DropdownMenuItem onClick={onDisable}>
							<HugeiconsIcon className="size-4" icon={PauseIcon} />
							{disableLabel}
						</DropdownMenuItem>
					) : null
				) : onEnable ? (
					<DropdownMenuItem onClick={onEnable}>
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
						{enableLabel}
					</DropdownMenuItem>
				) : null)}
			{canReport ? (
				<DropdownMenuItem onClick={onReport}>
					<HugeiconsIcon className="size-4" icon={Alert02Icon} />
					Report
				</DropdownMenuItem>
			) : null}
			{onUninstall ? (
				<>
					{hasToggleItem || canReport ? <DropdownMenuSeparator /> : null}
					<DropdownMenuItem onClick={onUninstall} variant="destructive">
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
						Remove
					</DropdownMenuItem>
				</>
			) : null}
		</>
	);
}

/**
 * The rows of a catalog card's RIGHT-CLICK menu — the same verbs the card's own
 * control offers, in the same order.
 *
 * It exists because the two menus cannot share a renderer: the dropdown is built
 * from `DropdownMenuItem` and a context menu from `ContextMenuItem`, and Base UI
 * gives each its own keyboard/roving-focus wiring, so one cannot be nested in
 * the other's content. Only the DECISIONS are shared, and they are stated once
 * here in the same shape {@link StoreItemAction} uses.
 *
 * Before this, right-click reached only NOT-installed cards, and only through
 * the Add button rather than the card — so the gesture worked on exactly the
 * listings you had not adopted yet and did nothing on the ones you manage. An
 * installed listing is the one with more to do to it, not less.
 *
 * Returns `undefined` when it would render nothing, so a caller can pass the
 * result straight to `contextMenu` and get no menu rather than an empty one.
 */
export function storeItemContextMenu({
	canReport,
	disableLabel = "Disable",
	enabled,
	enableLabel = "Enable",
	extra,
	incompatible = null,
	installed = false,
	locked = false,
	onDisable,
	onEnable,
	onInstall,
	onOpenSettings,
	onReport,
	onUninstall,
}: {
	canReport?: boolean;
	disableLabel?: string;
	/** `undefined` = no enable/disable concept, exactly as in StoreItemAction. */
	enabled?: boolean;
	enableLabel?: string;
	/** Extra rows, already `ContextMenuItem`s. Appended last. */
	extra?: React.ReactNode;
	/** Non-null when host floors are unmet — Get and Enable are withheld, since
	 *  Core refuses both, but Remove for an on-disk copy stays. */
	incompatible?: string | null;
	installed?: boolean;
	/** Built-in / un-removable: no Remove row. */
	locked?: boolean;
	onDisable?: () => void;
	onEnable?: () => void;
	onInstall?: () => void;
	onOpenSettings?: () => void;
	onReport?: () => void;
	onUninstall?: () => void;
}): React.ReactNode | undefined {
	const rows: React.ReactNode[] = [];
	const report = canReport && onReport ? onReport : undefined;

	if (!installed) {
		if (onInstall && !incompatible) {
			rows.push(
				<ContextMenuItem key="add" onClick={onInstall}>
					<HugeiconsIcon className="size-4" icon={Download04Icon} />
					Get
				</ContextMenuItem>
			);
		}
		if (report) {
			if (rows.length > 0) {
				rows.push(<ContextMenuSeparator key="sep-report" />);
			}
			rows.push(
				<ContextMenuItem key="report" onClick={report}>
					<HugeiconsIcon className="size-4" icon={Alert02Icon} />
					Report
				</ContextMenuItem>
			);
		}
		if (extra) {
			rows.push(<Fragment key="extra">{extra}</Fragment>);
		}
		return rows.length > 0 ? rows : undefined;
	}

	// Installed. Settings leads for the same reason it leads the dropdown: it is
	// why you open the menu on something that is already working.
	if (onOpenSettings) {
		rows.push(
			<ContextMenuItem key="settings" onClick={onOpenSettings}>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
				Settings
			</ContextMenuItem>
		);
	}
	// An unmet host floor means the item cannot run here at all, so the toggle is
	// withheld — offering Enable would read as "one click from working".
	if (enabled !== undefined && !incompatible) {
		if (enabled && onDisable) {
			rows.push(
				<ContextMenuItem key="disable" onClick={onDisable}>
					<HugeiconsIcon className="size-4" icon={PauseIcon} />
					{disableLabel}
				</ContextMenuItem>
			);
		} else if (!enabled && onEnable) {
			rows.push(
				<ContextMenuItem key="enable" onClick={onEnable}>
					<HugeiconsIcon className="size-4" icon={PlayIcon} />
					{enableLabel}
				</ContextMenuItem>
			);
		}
	}
	if (report) {
		rows.push(
			<ContextMenuItem key="report" onClick={report}>
				<HugeiconsIcon className="size-4" icon={Alert02Icon} />
				Report
			</ContextMenuItem>
		);
	}
	if (extra) {
		rows.push(<Fragment key="extra">{extra}</Fragment>);
	}
	if (onUninstall && !locked) {
		if (rows.length > 0) {
			rows.push(<ContextMenuSeparator key="sep-remove" />);
		}
		rows.push(
			<ContextMenuItem key="remove" onClick={onUninstall} variant="destructive">
				<HugeiconsIcon className="size-4" icon={Delete01Icon} />
				Remove
			</ContextMenuItem>
		);
	}
	return rows.length > 0 ? rows : undefined;
}

/**
 * Standalone 3-dot overflow for items whose primary control is static — the
 * locked (built-in) status glyph, the read-only web affordance, and the "Required"
 * badge a mandatory listing renders instead of lifecycle buttons. Holds Settings
 * and/or Report; renders nothing when it would be empty, so a caller can mount it
 * unconditionally.
 *
 * Exported because the mandatory-listing branch has no StoreItemAction to hang
 * these off: it deliberately renders no lifecycle control, but a required app is
 * still configurable and its settings must stay reachable from the card.
 */
export function StoreItemOverflowMenu({
	onOpenSettings,
	onReport,
	className,
	extra,
}: {
	className?: string;
	/** Appended after Settings/Report — see {@link StoreItemActionProps.extra}. */
	extra?: React.ReactNode;
	onOpenSettings?: () => void;
	onReport?: () => void;
}) {
	if (!(onOpenSettings || onReport || extra)) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="More actions"
						className={className}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{onOpenSettings ? (
					<DropdownMenuItem onClick={onOpenSettings}>
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</DropdownMenuItem>
				) : null}
				{onReport ? (
					<DropdownMenuItem onClick={onReport}>
						<HugeiconsIcon className="size-4" icon={Alert02Icon} />
						Report
					</DropdownMenuItem>
				) : null}
				{extra}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
