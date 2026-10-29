// Updates tab for the *desktop app itself* (the Tauri client), inside the App
// Settings dialog. Its sibling — `UpdatesSettings.tsx` in the Gateway dialog —
// covers the node's Core/Gateway binaries. The two are separate installs that
// can sit at different versions (Core is downloaded and updated independently
// of the shell), so this tab reads the running app's own version from Tauri
// rather than Core's `/api/version`.
//
// It renders the same shared `UpdatesView` block as the Gateway tab, with
// app-specific download copy and an explicit install/restart action.
//
// The automatic-download switch is deliberately Desktop-local: it controls
// whether this Tauri process may stage an app artifact on this device. Gateway's
// automatic-updates switch still governs the active node's Core binaries.

import { UpdatesView } from "@ryu/blocks/desktop/updates.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sileo } from "sileo";
import {
	canDeferAppUpdate,
	installUpdate,
	isEligibleForAppUpdate,
	prepareUpdate,
	showDownloadUpdatePrompt,
	showPreparedUpdatePrompt,
} from "@/src/components/updater/AutoUpdater.tsx";
import {
	APP_UPDATE_DOWNLOAD_ARIA_LABEL,
	APP_UPDATE_DOWNLOAD_DESCRIPTION,
	APP_UPDATE_DOWNLOAD_TITLE,
	APP_UPDATE_INSTALL_ACTION,
} from "@/src/components/updater/app-update-policy.ts";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	checkForUpdate,
	getVersionInfo,
	type UpdateCheck,
	updateCheckFailed,
} from "@/src/lib/api/update.ts";
import {
	getAutomaticAppUpdateDownload,
	getPreparedAppUpdate,
	getPreparedAppUpdateSnapshot,
	setAutomaticAppUpdateDownload,
	subscribePreparedAppUpdate,
} from "@/src/lib/app-update-preparation.ts";
import {
	clearPendingAppUpdate,
	describePendingAppUpdate,
	getPendingAppUpdate,
	type PendingAppUpdate,
	scheduleAppUpdate,
} from "@/src/lib/app-update-schedule.ts";
import { verdictAppliesToApp } from "@/src/lib/app-version.ts";
import { appDisplayName } from "@/src/lib/channel-brand.ts";
import {
	formatUpdatesCutoff,
	getUpdatesWindowEnd,
} from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { ReleaseChannelPicker } from "./UpdatesSettings.tsx";

export function AppUpdatesSettings() {
	const tl = useLiteralMessages();
	const getNode = useActiveNodeGetter();
	const [version, setVersion] = useState<string | null>(null);
	const [automaticDownload, setAutomaticDownload] = useState(true);
	const [checking, setChecking] = useState(false);
	const [restricted, setRestricted] = useState(false);
	// The release a check found, held so the "install later" row has something to
	// book. Not derivable from the toast, which is fire-and-forget.
	const [available, setAvailable] = useState<UpdateCheck | null>(null);
	const [pending, setPending] = useState<PendingAppUpdate | null>(null);
	// Native preference commands complete independently, so a slow older write
	// could land after a newer one. Issue them in order, so the newest choice
	// is always the one written last.
	const preferenceWrites = useRef<Promise<void>>(Promise.resolve());
	// The value the native store last confirmed (initial read or accepted write)
	// and the id of the newest queued write. A refusal rolls back to the saved
	// value, never to a stale optimistic one, and only when no newer choice is
	// queued behind it (that choice decides what the switch shows).
	const savedAutomaticDownload = useRef(true);
	const latestPreferenceWrite = useRef(0);
	const preparedSnapshot = useSyncExternalStore(
		subscribePreparedAppUpdate,
		getPreparedAppUpdateSnapshot,
		getPreparedAppUpdateSnapshot
	);

	useEffect(() => {
		const target = toTarget(getNode());
		let active = true;
		void (async () => {
			// The app's own version comes from Tauri. Outside a Tauri shell (the
			// browser dev server) that call rejects, so fall back to Core's
			// reported version rather than showing nothing.
			const [appVersion, info, enabled, booked] = await Promise.all([
				getVersion().catch(() => null),
				getVersionInfo(target).catch(() => null),
				getAutomaticAppUpdateDownload(),
				getPendingAppUpdate(),
			]);
			if (!active) {
				return;
			}
			setVersion(appVersion ?? info?.ryu_version ?? null);
			savedAutomaticDownload.current = enabled;
			setAutomaticDownload(enabled);
			setPending(booked);
			await getPreparedAppUpdate().catch(() => null);
		})();
		return () => {
			active = false;
		};
	}, [getNode]);

	const onToggle = async (next: boolean) => {
		setAutomaticDownload(next);
		latestPreferenceWrite.current += 1;
		const writeId = latestPreferenceWrite.current;
		const write = preferenceWrites.current.then(() =>
			setAutomaticAppUpdateDownload(next)
		);
		preferenceWrites.current = write.then(
			() => undefined,
			() => undefined
		);
		const saved = await write.catch(() => false);
		if (saved) {
			savedAutomaticDownload.current = next;
			return;
		}
		if (writeId !== latestPreferenceWrite.current) {
			return;
		}
		setAutomaticDownload(savedAutomaticDownload.current);
		sileo.error({ title: "Could not save the automatic-download setting" });
	};

	const onCheck = async () => {
		setChecking(true);
		try {
			// Resolve the node ONCE: the clamp decision and the install must target
			// the same node even if the active one changes mid-await.
			const node = getNode();
			// Clamp ONLY this app's own local node — a remote/cloud Core has no
			// lifetime owner. See `CheckForUpdateOptions.clamp`.
			const verdict = await checkForUpdate(toTarget(node), {
				clamp: isLocalNode(node),
			});
			// A failed check surfaces as either the fail-soft sentinel (empty
			// version strings, see update.ts) or Core's fail-open verdict with an
			// `error` field. Both must never read as "you're up to date".
			if (updateCheckFailed(verdict)) {
				// Drop any earlier verdict so "Install later" cannot book a release
				// this failed check could not confirm is still the newest.
				setAvailable(null);
				sileo.error({
					title: "Couldn't check for updates",
					description: verdict.error ?? "Check your connection and try again.",
				});
				return;
			}
			setRestricted(verdict.restricted_by_cutoff === true);
			// This tab is about the APP bundle — that is why the version above comes
			// from Tauri rather than Core's `/api/version`. The verdict has to be
			// held to the same standard: Core reports its OWN version as `current`,
			// and a `~/.ryu/bin/ryu-core` left behind at an older version made this
			// check answer "Update available — v0.1.3" to an app already on 0.1.3.
			const appIsBehind = await verdictAppliesToApp(verdict);
			// Only hold a verdict that can actually be BOOKED. A deferral is
			// replayed at the window without a re-check, so it needs a local node's
			// verdict, a tag to pin to, and a non-rolling channel; without those the
			// install would silently resolve to whatever is newest then. Hiding the
			// offer is the honest failure — the alternative is a button that takes
			// the promise and breaks it eight hours later, unattended.
			setAvailable(
				appIsBehind && canDeferAppUpdate(verdict, node) ? verdict : null
			);
			if (!appIsBehind) {
				// An explicit check asks a factual question and must get a factual
				// answer — not a persistent purchase prompt. Finite duration, both
				// versions named.
				if (verdict.restricted_by_cutoff) {
					sileo.info({
						title: "Ryu is up to date for your updates window",
						description: verdict.cutoff_unresolved
							? tl(
									"v{latestVersion} has been released, after your updates window ended.",
									{
										latestVersion:
											verdict.latest_unrestricted ?? verdict.latest,
									}
								)
							: // `version` (the app's own, from Tauri) not `verdict.current`
								// (the answering Core's) — this sentence names the build the
								// user is looking at in the row right above it.
								tl(
									"You're on v{currentVersion}. v{latestVersion} was released after your updates window ended.",
									{
										currentVersion: version ?? verdict.current,
										latestVersion:
											verdict.latest_unrestricted ?? verdict.latest,
									}
								),
						duration: 8000,
						button: {
							title: "Extend updates",
							onClick: () => {
								useSettingsDialog.getState().openSettings("billing");
							},
						},
					});
					return;
				}
				sileo.success({ title: "Ryu is up to date" });
				return;
			}
			if (!automaticDownload) {
				showDownloadUpdatePrompt(verdict, { node });
				return;
			}
			try {
				const prepared = await prepareUpdate(verdict, { node });
				if (prepared) {
					showPreparedUpdatePrompt(verdict, { node });
				} else if (isEligibleForAppUpdate(verdict)) {
					// Outside the updates window `prepareUpdate` already said so; a
					// second "Download update" toast on top would only repeat it.
					showDownloadUpdatePrompt(verdict, { node });
				}
			} catch (error) {
				sileo.error({
					title: "Update download failed",
					description: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			setChecking(false);
		}
	};

	// Book the found release for this machine's next quiet hour.
	//
	// The WHOLE verdict is stored, not just its version: what installs at the
	// window is then the build the user is looking at right now, notes and all.
	// Re-checking then would resolve the static feed to whatever is newest at
	// 03:00 — a different release, on a machine they deliberately chose not to
	// touch during the day.
	const onDefer = async () => {
		if (!available) {
			return;
		}
		try {
			const booked = await scheduleAppUpdate(available);
			setPending(booked);
			sileo.info({ title: describePendingAppUpdate(booked), duration: 8000 });
		} catch (err) {
			// A deferral that could not be written must never be reported as booked
			// — that is the exact failure shape this whole feature exists to avoid.
			sileo.error({
				title: "Couldn't schedule the update",
				description: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const onCancelDefer = async () => {
		if (!(await clearPendingAppUpdate())) {
			sileo.error({
				title: "Couldn't cancel the scheduled update",
				description: "The update is still scheduled. Try cancelling it again.",
			});
			return;
		}
		setPending(null);
		sileo.info({ title: "Scheduled update cancelled", duration: 4000 });
	};

	const onInstallPrepared = async () => {
		setChecking(true);
		try {
			const node = getNode();
			const verdict = await checkForUpdate(toTarget(node), {
				clamp: isLocalNode(node),
			});
			if (updateCheckFailed(verdict)) {
				// Drop any earlier verdict so "Install later" cannot book a release
				// this failed check could not confirm is still the newest.
				setAvailable(null);
				sileo.error({
					title: "Couldn't verify the prepared update",
					description: verdict.error ?? "Check your connection and try again.",
				});
				return;
			}
			if (!(await verdictAppliesToApp(verdict))) {
				await getPreparedAppUpdate().catch(() => null);
				sileo.success({ title: "Ryu is up to date" });
				return;
			}
			await installUpdate(verdict, { node });
		} finally {
			setChecking(false);
		}
	};

	// Read straight from storage on every render. The window is written outside
	// React (the entitlement resolve, at launch), so there is nothing to subscribe
	// to: the normal case is that the value is already there on mount, and the
	// `setRestricted` re-render below is what refreshes it after a check. Caching
	// it in state would freeze the row in whatever it read first.
	const windowEnd = getUpdatesWindowEnd();
	// Two different notices, deliberately. A lapsed window with nothing actually
	// withheld is not a reason to sell: the owner is losing nothing until a release
	// they cannot have exists. Only a verdict that came back genuinely clamped
	// earns the buy-again copy and the button.
	let updatesWindowNotice: string | undefined;
	if (windowEnd) {
		updatesWindowNotice = restricted
			? tl(
					"Your lifetime updates ended on {endDate}. Ryu stays on the newest build they cover. Buy lifetime access again at the current price for another year, or post about Ryu at ryu.com/redeem to earn a free year.",
					{ endDate: formatUpdatesCutoff(windowEnd) }
				)
			: tl("Updates included through {endDate}.", {
					endDate: formatUpdatesCutoff(windowEnd),
				});
	}

	return (
		<div className="space-y-6">
			<p className="text-muted-foreground text-sm">
				App updates can restart the local runtime and stop running chats, tools,
				and workflows. Ryu asks before installation so you can keep working.
				Remote nodes continue running.
			</p>
			<UpdatesView
				automaticUpdateAriaLabel={APP_UPDATE_DOWNLOAD_ARIA_LABEL}
				automaticUpdateDescription={APP_UPDATE_DOWNLOAD_DESCRIPTION}
				automaticUpdateTitle={APP_UPDATE_DOWNLOAD_TITLE}
				autoUpdate={automaticDownload}
				checking={checking}
				deferredInstallNotice={
					pending ? describePendingAppUpdate(pending) : undefined
				}
				installPreparedDisabled={checking}
				installPreparedLabel={APP_UPDATE_INSTALL_ACTION}
				onCancelDeferredInstall={
					pending
						? () => {
								onCancelDefer().catch(() => undefined);
							}
						: undefined
				}
				onCheck={() => {
					onCheck().catch(() => undefined);
				}}
				// Only offered once a check has actually found something to defer.
				// A "book it for tonight" button with no release behind it would be
				// a promise about a version that may not exist.
				onDeferInstall={
					available && !pending
						? () => {
								onDefer().catch(() => undefined);
							}
						: undefined
				}
				onInstallPreparedUpdate={
					preparedSnapshot.kind === "ready"
						? () => {
								onInstallPrepared().catch(() => undefined);
							}
						: undefined
				}
				onManageUpdates={
					restricted
						? () => useSettingsDialog.getState().openSettings("billing")
						: undefined
				}
				onToggle={(next) => {
					onToggle(next).catch(() => undefined);
				}}
				preparedUpdateNotice={
					preparedSnapshot.kind === "ready"
						? tl(
								"v{version} is downloaded and signature-verified. Install it when you're ready.",
								{ version: preparedSnapshot.update.version }
							)
						: undefined
				}
				productName={appDisplayName(version)}
				updatesWindowNotice={updatesWindowNotice}
				version={version}
			/>
			<ReleaseChannelPicker />
		</div>
	);
}
