"use client";

// Presentational layer of the desktop Updates settings tab. The live app
// (`apps/desktop/src/components/settings/UpdatesSettings.tsx`) is a thin
// container that talks to Core's update API; the storyboard renders the same
// component with mock data. One source of truth, so editing this block changes
// the real desktop too.

import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Switch } from "@ryu/ui/components/switch";

export interface UpdatesViewProps {
	automaticUpdateAriaLabel?: string;
	automaticUpdateDescription?: string;
	automaticUpdateTitle?: string;
	autoUpdate?: boolean;
	checking?: boolean;
	/**
	 * Sentence naming an install already booked for the machine's quiet hour.
	 * When set, the row offers to cancel instead of to book.
	 *
	 * The caller owns the wording, and must not promise the hour itself: unlike a
	 * node, a laptop is usually asleep or quit at 03:00, so the truthful sentence
	 * is about the next launch after the window. See
	 * `apps/desktop/src/lib/app-update-schedule.ts`.
	 */
	deferredInstallNotice?: string;
	installPreparedDisabled?: boolean;
	installPreparedLabel?: string;
	/** Cancels the booked install. Renders the cancel action only when supplied. */
	onCancelDeferredInstall?: () => void;
	onCheck?: () => void;
	/**
	 * Books the update for the machine's next quiet hour. Renders the row only
	 * when supplied — the Gateway tab governs a node's binaries, which defer
	 * through the node's own scheduler, and leaves this off.
	 */
	onDeferInstall?: () => void;
	onInstallPreparedUpdate?: () => void;
	/** Called when the owner asks to manage/extend their updates window. Renders
	 *  the action button only when supplied. */
	onManageUpdates?: () => void;
	onToggle?: (next: boolean) => void;
	preparedUpdateNotice?: string;
	/**
	 * Set only for a lifetime owner: states through when updates are included, and —
	 * once something is actually being withheld — how to get another year. Absent
	 * for everyone else, which leaves this tab exactly as it renders today.
	 */
	/**
	 * The bundle's OS-registered name including its release channel — "Ryu
	 * (Nightly)", "Ryu (Research Preview)". Set by the App tab, which knows the
	 * running bundle's version; the Gateway tab governs Core, which has no bundle
	 * name, and leaves it off.
	 */
	productName?: string | null;
	updatesWindowNotice?: string;
	version?: string | null;
}

/** "Ryu (Nightly) — current version: v0.1.4-nightly.20260806.12." */
function versionCaption(
	version: string | null | undefined,
	productName: string | null | undefined,
	tl: LiteralMessage
): string | undefined {
	if (!version) {
		return productName ?? undefined;
	}
	return productName
		? tl("{productName} — current version: v{version}.", {
				productName,
				version,
			})
		: tl("Current version: v{version}.", { version });
}

export function UpdatesView({
	version,
	productName,
	autoUpdate = true,
	automaticUpdateAriaLabel = "Toggle automatic updates",
	automaticUpdateDescription = "Check for updates on launch and install them automatically.",
	automaticUpdateTitle = "Automatic updates",
	checking,
	deferredInstallNotice,
	installPreparedDisabled = false,
	onToggle,
	onCancelDeferredInstall,
	onCheck,
	onDeferInstall,
	onManageUpdates,
	onInstallPreparedUpdate,
	installPreparedLabel = "Install and restart",
	preparedUpdateNotice,
	updatesWindowNotice,
}: UpdatesViewProps) {
	const tl = useLiteralMessages();
	return (
		<div className="space-y-6">
			<SettingsSection
				caption={versionCaption(version, productName, tl)}
				title="Software updates"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label={automaticUpdateAriaLabel}
								checked={autoUpdate}
								onCheckedChange={onToggle}
							/>
						}
						description={automaticUpdateDescription}
						title={automaticUpdateTitle}
					/>
					{preparedUpdateNotice ? (
						<SettingsItem
							actions={
								onInstallPreparedUpdate ? (
									<Button
										disabled={installPreparedDisabled}
										onClick={onInstallPreparedUpdate}
										size="sm"
										variant="default"
									>
										{installPreparedLabel}
									</Button>
								) : undefined
							}
							description={preparedUpdateNotice}
							title="Update ready"
						/>
					) : null}
					<SettingsItem
						actions={
							<Button
								disabled={checking}
								onClick={onCheck}
								size="sm"
								variant="outline"
							>
								{checking ? "Checking…" : "Check for updates"}
							</Button>
						}
						description="Manually check for a new release now."
						title="Check for updates"
					/>
					{deferredInstallNotice || onDeferInstall ? (
						<SettingsItem
							actions={
								deferredInstallNotice ? (
									onCancelDeferredInstall ? (
										<Button
											onClick={onCancelDeferredInstall}
											size="sm"
											variant="outline"
										>
											Cancel
										</Button>
									) : undefined
								) : (
									<Button onClick={onDeferInstall} size="sm" variant="outline">
										Install later
									</Button>
								)
							}
							description={
								deferredInstallNotice ??
								"Restarting mid-task loses whatever is running. Book the install for tonight instead."
							}
							title="Install later"
						/>
					) : null}
					{updatesWindowNotice ? (
						<SettingsItem
							actions={
								onManageUpdates ? (
									<Button onClick={onManageUpdates} size="sm" variant="outline">
										Extend updates
									</Button>
								) : undefined
							}
							description={updatesWindowNotice}
							title="Lifetime updates"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
