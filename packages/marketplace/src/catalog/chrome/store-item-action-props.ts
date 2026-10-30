import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import type { ReportTarget } from "../../report/types.ts";
import type { PublisherHealthInput } from "../detail/publisher-health.ts";

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
