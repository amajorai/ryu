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
	Download04Icon,
	MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
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
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import { useOptionalReport } from "../../report/report-provider.tsx";
import type { StoreItemActionProps } from "./store-item-action-props.ts";
import { PublisherInstallDisclosure } from "./store-item-disclosure.tsx";
import {
	StoreItemMenuItems,
	StoreItemOverflowMenu,
} from "./store-item-menu.tsx";

export type {
	PublisherInstallDisclosureProps,
	StoreItemActionProps,
} from "./store-item-action-props.ts";
export { PublisherInstallDisclosure } from "./store-item-disclosure.tsx";
export {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "./store-item-menu.tsx";

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
	const tl = useLiteralMessages();
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
			isNativeNumber(downloadCount) &&
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
						aria-label={
							idleLabel
								? tl("Get — {idleLabel} downloads", { idleLabel })
								: "Get"
						}
						className={idleLabel ? "group" : undefined}
						idleVariant="outline"
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
					className="size-3.5 text-status-success"
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
