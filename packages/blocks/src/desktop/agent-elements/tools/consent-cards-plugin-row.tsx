import { Loading03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import type { ReactNode } from "react";
import {
	InlineError,
	ListingIcon,
	PluginStats,
	TrustTierMark,
} from "./consent-cards-shared.tsx";
import type { ConsentPluginCandidate } from "./consent-tool.ts";

export function PluginRow({
	busy,
	candidate,
	disabled,
	error,
	installedHere,
	onInstall,
	onOpenStore,
	onReview,
	onUse,
	recommended,
}: {
	busy: boolean;
	candidate: ConsentPluginCandidate;
	disabled: boolean;
	error: string | null;
	installedHere: boolean;
	onInstall: () => void;
	onOpenStore: () => void;
	onReview: () => void;
	onUse: () => void;
	recommended: boolean;
}) {
	const installed = candidate.installed || installedHere;
	const turnedOff = candidate.installed && !candidate.enabled;
	let action: ReactNode = null;
	let note: string | null = null;
	if (installedHere) {
		action = (
			<Badge variant="secondary">
				<HugeiconsIcon aria-hidden icon={Tick02Icon} />
				Installed
			</Badge>
		);
	} else if (candidate.storeOnly) {
		// Checked before the installed state: that is matched by id only, so a
		// same-id package installed from another marketplace must not make this
		// listing look installed.
		note =
			"Listed in another marketplace. Install it from the Store, where you can see which one.";
		action = (
			<Button
				disabled={disabled}
				onClick={onOpenStore}
				size="xs"
				variant="outline"
			>
				Open in Store
			</Button>
		);
	} else if (turnedOff) {
		note =
			"Installed but turned off. Turn it on in the Store to review its permissions.";
		action = (
			<Button
				disabled={disabled}
				onClick={onOpenStore}
				size="xs"
				variant="outline"
			>
				Open in Store
			</Button>
		);
	} else if (installed) {
		action = (
			<Button disabled={disabled} onClick={onUse} size="xs" variant="outline">
				Use it
			</Button>
		);
	} else if (candidate.installable) {
		action = (
			<Button
				disabled={disabled || busy}
				onClick={onInstall}
				size="xs"
				variant={recommended ? "default" : "outline"}
			>
				{busy ? (
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 animate-spin"
						icon={Loading03Icon}
					/>
				) : null}
				{busy ? "Installing" : "Install"}
			</Button>
		);
	} else if (candidate.reviewUrl) {
		note =
			"Community plugins can't be installed from chat. Review the source first, then install it from the Store.";
		action = (
			<Button disabled={disabled} onClick={onReview} size="xs" variant="ghost">
				Review
			</Button>
		);
	} else {
		note =
			"Can't be installed from chat, and the listing has no source link to review.";
	}
	return (
		<li
			className="flex items-start gap-3 px-3 py-2"
			data-plugin-id={candidate.id}
			data-testid="consent-plugin-row"
			data-tier={candidate.tier}
		>
			<ListingIcon name={candidate.name} url={candidate.iconUrl} />
			<div className="min-w-0 flex-1 space-y-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<p className="truncate font-medium" title={candidate.name}>
						{candidate.name}
					</p>
					<TrustTierMark tier={candidate.tier} />
					{recommended && !installed ? (
						<Badge variant="outline">Recommended</Badge>
					) : null}
					{candidate.reviewed === false ? (
						<Badge className="text-status-warning" variant="outline">
							Not reviewed by Ryu
						</Badge>
					) : null}
				</div>
				{candidate.description ? (
					<p className="line-clamp-1 text-muted-foreground text-xs">
						{candidate.description}
					</p>
				) : null}
				<PluginStats candidate={candidate} />
				{note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
				{error ? <InlineError message={error} /> : null}
			</div>
			{action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
		</li>
	);
}
