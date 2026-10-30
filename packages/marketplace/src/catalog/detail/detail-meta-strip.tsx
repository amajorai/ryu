import {
	Calendar01Icon,
	ComputerIcon,
	Download01Icon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { surfaceLabel } from "../surface-labels.ts";
import type { CatalogEntry, PluginCatalogDetail } from "../types.ts";
import { formatCount, formatDate } from "./detail-format.ts";

/** One item in the strip under the listing name. */
export function MetaItem({
	icon,
	label,
	value,
}: {
	icon: typeof Tag01Icon;
	label: string;
	value: string;
}) {
	return (
		<span
			className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
			title={label}
		>
			<HugeiconsIcon className="size-3.5" icon={icon} />
			{value}
		</span>
	);
}

/**
 * The metadata strip: current version, when it last changed, how many times it
 * has been downloaded, and which surfaces it runs on.
 *
 * Every item is conditional. A listing that reports none of them renders nothing
 * at all rather than a row of dashes.
 */
/** NOT MOUNTED ANY MORE. The listing detail's meta facts are now the divided
 *  cells of `listing-detail-shell.tsx`'s {@link ListingStatStrip}, which is what
 *  a wide dialog needs — this inline flex-wrap row read as a single ribbon of
 *  grey text where the store's headline facts belong. Kept because it is still
 *  the right shape for a NARROW, non-dialog surface (a card back, a hover
 *  preview); if you are adding facts to the listing dialog, add a stat cell
 *  instead, and delete this once something proves it has no such caller. */
export function DetailMetaStrip({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const version = detail?.version ?? entry.version ?? null;
	const updated = formatDate(detail?.updatedAt);
	const created = formatDate(detail?.createdAt);
	const downloads = detail?.downloads ?? null;
	// Fall back to the CARD's surfaces when the detail fetch has not landed (or the
	// source serves no detail at all). This is load-bearing now that the card no
	// longer shows the badges itself: without the fallback, "which platforms does
	// this run on?" would be unanswerable anywhere for a descriptor-only listing.
	const surfaces = detail?.surfaces ?? entry.surfaces ?? [];

	const items = [
		version
			? {
					icon: Tag01Icon,
					label: "Current version",
					value: `v${version.replace(/^v/, "")}`,
				}
			: null,
		updated
			? {
					icon: Calendar01Icon,
					label: "Last updated",
					value: `Updated ${updated}`,
				}
			: null,
		created
			? {
					icon: Calendar01Icon,
					label: "First published",
					value: `Created ${created}`,
				}
			: null,
		isNativeNumber(downloads)
			? {
					icon: Download01Icon,
					label: "Downloads",
					value: `${formatCount(downloads)} downloads`,
				}
			: null,
	].filter((item): item is Exclude<typeof item, null> => Boolean(item));

	if (items.length === 0 && surfaces.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
			{items.map((item) => (
				<MetaItem
					icon={item.icon}
					key={item.label}
					label={item.label}
					value={item.value}
				/>
			))}
			{surfaces.length > 0 ? (
				<span className="inline-flex items-center gap-1.5">
					<HugeiconsIcon
						className="size-3.5 text-muted-foreground"
						icon={ComputerIcon}
					/>
					{surfaces.map((surface) => (
						<Badge key={surface} variant="outline">
							{surfaceLabel(surface)}
						</Badge>
					))}
				</span>
			) : null}
		</div>
	);
}
