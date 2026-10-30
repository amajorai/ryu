import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { useOptionalReport } from "../report/report-provider.tsx";
import { formatPrice } from "../types.ts";
import StoreItemAction, {
	PublisherInstallDisclosure,
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "./chrome/store-item-action.tsx";
import type { PublisherHealthInput } from "./detail/publisher-health.ts";
import { useEntryIncompatibility } from "./host.tsx";
import type { AppCatalogItem, CatalogEntry } from "./types.ts";

/** True when this listing is required for Core and must never be offered a
 *  Disable/Uninstall control.
 *
 *  Gated on `source === "built-in"` as well as the flag. `mandatory` arrives on an
 *  entry that may have come from a remote catalog, and "you cannot turn this off"
 *  is precisely the claim a hostile listing would make about itself; Core only ever
 *  stamps it from its own constant, so a non-built-in entry carrying it is either
 *  lying or a source bug. Trusting it there would let a third-party listing render
 *  itself as un-removable — and the lifecycle would not back that up, so the user
 *  would be stuck looking at an app with no way to remove it and no explanation.
 *
 *  Exported for unit tests. */
export function isMandatoryListing(entry: CatalogEntry): boolean {
	return entry.mandatory === true && entry.source === "built-in";
}

/** The download-center task id Core registers an add under.
 *
 *  One scheme, declared once, shared by every path that adds a plugin — the
 *  catalog resolve, the built-in store write, and the update re-resolve all
 *  register `plugin:<id>`, so a retry dedupes onto the same row and a button can
 *  find its own transfer by id instead of guessing from a label.
 *
 *  Exported for unit tests. */
export function pluginDownloadTaskId(id: string): string {
	return `plugin:${id}`;
}

/** Card action for an app: Add (inline), Enabled↔Disable morph (Disable
 *  inline), or Disabled→Enable which opens the preview so its grant dialog runs.
 *  Descriptor-only rows + read-only surfaces just open the preview. */
/** The health signals the unverified-publisher install disclosure shows. One
 *  builder for the card, its context menu, and the detail hero so the three
 *  install paths cannot drift. */
export function appPublisherHealth(
	entry: CatalogEntry
): Omit<PublisherHealthInput, "publisherTrust"> {
	return {
		capabilities: entry.capabilities,
		packageChecksum: entry.package_checksum,
		reviewed: entry.reviewed,
		signatureStatus: "unknown",
	};
}

/**
 * The right-click rows for an app card — the same decisions {@link AppCardAction}
 * makes, restated for the context-menu primitive.
 *
 * A component rather than a call to `storeItemContextMenu` at the card site
 * because the incompatibility verdict comes from a HOOK, and the card is rendered
 * inside a `.map`. Only reached when `canInstall`, so the read-only web store is
 * untouched: there, the card carries no lifecycle verbs and a menu holding
 * nothing but "Report" would be worse than none.
 */
export function AppCardContextMenu({
	item,
	onInstall,
	onDisable,
	onOpen,
	onOpenSettings,
}: {
	item: AppCatalogItem;
	onDisable: () => void;
	onInstall: () => void;
	onOpen: () => void;
	onOpenSettings?: (() => void) | null;
}) {
	const incompatible = useEntryIncompatibility(item.entry);
	const reportCtx = useOptionalReport();
	const target = reportTargetForApp(item);
	const canReport = Boolean(reportCtx && target);
	const onReport = () => reportCtx?.open(target);
	const [communityDialogOpen, setCommunityDialogOpen] = useState(false);
	const publisherTrust = item.entry.publisher_trust;
	const needsCommunityDisclosure =
		!item.installed && publisherTrust === "dotted";
	const guardedInstall = () => {
		if (needsCommunityDisclosure) {
			setCommunityDialogOpen(true);
			return;
		}
		onInstall();
	};
	const communityDisclosure = needsCommunityDisclosure ? (
		<PublisherInstallDisclosure
			onInstall={onInstall}
			onOpenChange={setCommunityDialogOpen}
			open={communityDialogOpen}
			publisherHealth={appPublisherHealth(item.entry)}
			publisherTrust={publisherTrust ?? "dotted"}
		/>
	) : null;

	// A mandatory listing is un-removable and un-disableable (Core 403s both), so
	// it gets the locked shape: Settings and Report only.
	if (isMandatoryListing(item.entry)) {
		return (
			<>
				{storeItemContextMenu({
					canReport,
					installed: true,
					locked: true,
					onOpenSettings: onOpenSettings ?? undefined,
					onReport,
				})}
				{communityDisclosure}
			</>
		);
	}
	return (
		<>
			{storeItemContextMenu({
				canReport,
				enabled: item.enabled,
				incompatible,
				installed: item.installed,
				onDisable,
				onEnable: onOpen,
				onInstall: guardedInstall,
				onOpenSettings: onOpenSettings ?? undefined,
				onReport,
			})}
			{communityDisclosure}
		</>
	);
}

export function AppCardAction({
	item,
	canInstall,
	pending,
	downloadCount,
	onInstall,
	onDisable,
	onOpen,
	onOpenSettings,
}: {
	item: AppCatalogItem;
	canInstall: boolean;
	pending: boolean;
	downloadCount?: number | null;
	onInstall: () => void;
	onDisable: () => void;
	onOpen: () => void;
	/** Reveal this listing's settings tab; absent when it declares none. */
	onOpenSettings?: (() => void) | null;
}) {
	// Called before every early return below — rules of hooks. Re-evaluates the
	// listing's declared floors with THIS client's surface versions overlaid on
	// Core's verdict, which is what makes a desktop/island floor enforceable at all
	// (Core cannot observe those surfaces and reports them as advisory).
	const incompatible = useEntryIncompatibility(item.entry);

	// A mandatory listing gets NO lifecycle control at all — not a disabled one.
	// Core refuses both disable and uninstall for it with a 403 and no force
	// override, so any button here could only ever produce an error toast. A greyed
	// button would still read as "there is something to do here"; the honest UI is a
	// static label saying why the controls are absent.
	if (isMandatoryListing(item.entry)) {
		// It still gets a Settings route, though: "cannot be removed" says nothing
		// about "cannot be configured", and a required app is often the one with the
		// most to configure. The overflow renders nothing when there is no settings
		// destination, so the badge stays alone in that case.
		return (
			<div className="flex shrink-0 items-center gap-1">
				<Badge variant="secondary">Required</Badge>
				<StoreItemOverflowMenu onOpenSettings={onOpenSettings ?? undefined} />
			</div>
		);
	}
	if (item.entry.descriptor_only || !canInstall) {
		return (
			<div className="flex items-center gap-1.5">
				<PriceBadge entry={item.entry} />
				<StoreItemAction
					affordance={
						<Button onClick={onOpen} size="sm" variant="ghost">
							Details
						</Button>
					}
					installed={false}
					onOpenSettings={onOpenSettings ?? undefined}
					reportTarget={reportTargetForApp(item)}
				/>
			</div>
		);
	}
	return (
		<div className="flex items-center gap-1.5">
			{/* Price sits beside the action, not inside it: a paid listing the user
			    already owns still installs with the normal button, so the amount is
			    disclosure rather than a call to action. */}
			{item.installed ? null : <PriceBadge entry={item.entry} />}
			<StoreItemAction
				busy={pending}
				downloadCount={downloadCount}
				enabled={item.enabled}
				incompatible={incompatible}
				installed={item.installed}
				onDisable={onDisable}
				onEnable={onOpen}
				onInstall={onInstall}
				onOpenSettings={onOpenSettings ?? undefined}
				publisherHealth={appPublisherHealth(item.entry)}
				publisherTrust={item.entry.publisher_trust}
				reportTarget={reportTargetForApp(item)}
			/>
		</div>
	);
}

/** The listing's price as a short label, or `null` when it is free.
 *
 *  Exported for unit tests. Free is represented by an ABSENT `pricing` (that is what
 *  the hosted catalog emits), so a zero amount is treated as free too rather than
 *  rendering "$0.00" — a price badge that says nothing costs attention for nothing. */
export function priceLabel(entry: CatalogEntry): string | null {
	const amount = entry.pricing?.amountMinor;
	if (!isNativeNumber(amount) || amount <= 0) {
		return null;
	}
	return formatPrice(amount, entry.pricing?.currency ?? "usd");
}

/** Paid-listing badge. Rendered on the card and in the detail header, because the
 *  unified first-party view interleaves the free git catalog with the hosted paid
 *  listings — without it the two are indistinguishable until checkout. */
export function PriceBadge({ entry }: { entry: CatalogEntry }) {
	const label = priceLabel(entry);
	if (!label) {
		return null;
	}
	return (
		<Badge className="shrink-0" typography="price" variant="outline">
			{label}
		</Badge>
	);
}

export function reportTargetForApp(item: AppCatalogItem) {
	const origin = item.entry.origin;
	const source =
		origin === "community"
			? ("github-community" as const)
			: item.entry.provenance === "github-topic" ||
					item.entry.source?.includes("github")
				? ("github-curated" as const)
				: ("mongo" as const);
	return {
		id: item.entry.id,
		kind: "plugin",
		itemName: item.entry.name,
		homepage: item.entry.repo_url ?? null,
		installSource: item.entry.source ?? item.entry.repo_url ?? null,
		source,
	};
}
