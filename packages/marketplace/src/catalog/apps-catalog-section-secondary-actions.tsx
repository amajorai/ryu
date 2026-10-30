import { GitForkIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { type ReactNode, useState } from "react";
import {
	ChannelPicker,
	ChannelSwitchSummary,
	channelLabel,
	STABLE_CHANNEL,
	useListingChannels,
} from "./detail/channel-picker.tsx";
import { grantDescription, grantLabel } from "./grant-labels.ts";
import { useCatalogHost } from "./host.tsx";
import { remixableFromEntry, remixPlan } from "./remix.ts";
import type { AppCatalogItem } from "./types.ts";

/** Everything the hero's CTA row is NOT: the Settings shortcut, the release-train
 *  switch for an installed listing, the price / installed-state pills, and the
 *  inline action error.
 *
 *  These stay on a solid band under the hero because each of them is prose or a
 *  bordered form control — a `Select` and a sentence do not read on a saturated
 *  dither, and an error message least of all. */
export function AppSecondaryActions({
	item,
	error,
	onOpenSettings,
	status,
	switchChannel,
}: {
	item: AppCatalogItem;
	error: string | null;
	/** Reveal this listing's settings tab; absent when it declares none. */
	onOpenSettings?: (() => void) | null;
	/** Price / installed-state pills, pushed to the far end of the band. */
	status?: ReactNode;
	/** Move this INSTALLED listing onto another release train. Absent ⇒ the host
	 *  cannot update, so no switch is offered. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const host = useCatalogHost();
	const { entry, installed } = item;

	// Which train an installed listing FOLLOWS. An installed listing the host
	// cannot update is the one case with no choice to make, so it does not pay for
	// the read — and neither does an uninstalled one, whose train choice belongs to
	// AppPrimaryAction.
	const canSwitch = installed && Boolean(switchChannel);
	const { channels } = useListingChannels(
		entry.id,
		entry.repo_url,
		canSwitch ? host.fetchListingChannels : undefined
	);
	// The train a switch is WAITING ON confirmation for. A switch re-resolves and
	// re-installs a different build, can move the version backwards, and is not
	// undone by picking the old train again (that resolves whatever THAT train
	// holds now, not the build you had) — so it is confirmed, like enabling is.
	const [pendingChannel, setPendingChannel] = useState<string | null>(null);
	const [switchOpen, setSwitchOpen] = useState(false);

	// The train this install follows may have no PROMOTED build — that is exactly
	// the case the pin exists for (someone on `canary` while the canary train is
	// empty). The resolved list only carries trains with a build, so the pinned one
	// is added back; without it the selector would render a value matching no
	// option and show blank for a plugin that is very much on a channel.
	const followed = item.channel ?? null;
	const switchOptions =
		followed && !channels.some((c) => c.channel === followed)
			? [...channels, { channel: followed, installable: true, version: null }]
			: channels;

	const noop = () => {
		// intentionally empty: error is surfaced via the hook
	};
	// Remixing an app or plugin starts from a fork of its GitHub source; the fork
	// credits this listing through `remixedFrom` when it is published.
	const remix = remixPlan(remixableFromEntry(entry));

	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex w-full flex-wrap items-center gap-2">
				{remix.kind === "fork" ? (
					<Button
						nativeButton={false}
						render={
							<a
								aria-label={tl("Remix {name} by forking its source on GitHub", {
									name: entry.name,
								})}
								href={remix.forkUrl}
								rel="noopener noreferrer"
								target="_blank"
							/>
						}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={GitForkIcon} />
						Remix
					</Button>
				) : null}
				{/* Configuring an app is not part of installing or disabling it, which
				    is why this is here and not in the hero beside the lifecycle verb —
				    but it is still where a user who just clicked into the listing looks
				    for its API key. */}
				{onOpenSettings ? (
					<Button onClick={onOpenSettings} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</Button>
				) : null}
				{/* Which train an INSTALLED listing follows, and how to change it.
				    Rendered as a live control where the host can update, and as a
				    plain badge where it cannot — a picker that could not act on its
				    own selection would be worse than no picker.

				    The badge is skipped for a stable install: that is the
				    unremarkable case, and labelling it would put a chip on every row
				    to say nothing. */}
				{canSwitch && switchOptions.length > 1 ? (
					<ChannelPicker
						channels={switchOptions}
						onChange={(next) => {
							setPendingChannel(next);
							setSwitchOpen(true);
						}}
						value={followed}
					/>
				) : installed && item.channel && item.channel !== STABLE_CHANNEL ? (
					<Badge variant="outline">
						{tl("{channel} channel", { channel: channelLabel(item.channel) })}
					</Badge>
				) : null}
				{status ? (
					<span className="ml-auto flex shrink-0 items-center gap-2">
						{status}
					</span>
				) : null}
			</div>
			{error && <p className="text-sm text-status-destructive">{error}</p>}

			{/* Channel-switch confirmation. The version delta is the whole point of
			    asking: every prerelease sorts BELOW its stable release, so moving
			    onto a beta routinely installs an OLDER build, and a one-click
			    dropdown would do that silently and unrepeatably (switching back
			    resolves whatever stable holds now, not the build you had). */}
			{canSwitch ? (
				<AlertDialog onOpenChange={setSwitchOpen} open={switchOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{tl("Follow the {channel} channel?", {
									channel: channelLabel(pendingChannel ?? STABLE_CHANNEL),
								})}
							</AlertDialogTitle>
							<AlertDialogDescription>
								<ChannelSwitchSummary
									channels={switchOptions}
									installedVersion={item.installedVersion ?? entry.version}
									target={pendingChannel}
								/>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setSwitchOpen(false);
									switchChannel?.(entry.id, pendingChannel).catch(noop);
								}}
							>
								Switch
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</div>
	);
}

/** A list of permission grants in plain English (label + one-line description),
 *  so a non-technical user understands what they're approving. */
export function GrantList({ grants }: { grants: string[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{grants.map((g) => {
				const description = grantDescription(g);
				return (
					<li className="rounded-lg bg-muted px-3 py-1.5" key={g}>
						<div className="font-medium text-sm">{grantLabel(g)}</div>
						{description ? (
							<div className="text-muted-foreground text-xs">{description}</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
