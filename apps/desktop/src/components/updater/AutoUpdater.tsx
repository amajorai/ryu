import { useEffect, useRef } from "react";
import { sileo } from "sileo";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	checkForUpdate,
	FORCE_AUTO_UPDATE,
	getAutoUpdateEnabled,
	type UpdateCheck,
} from "@/src/lib/api/update.ts";
import { getReleaseChannel } from "@/src/lib/release-channel.ts";

// Launch-time auto-updater for the desktop. On mount it asks Core whether an
// update is available (Core is the single source of truth for the verdict and
// the shared auto-update toggle). The actual install is performed by
// tauri-plugin-updater — but the toast and the decision to auto-install are
// driven by Core's verdict, so every surface behaves consistently.
//
// - Forced (FORCE_AUTO_UPDATE) → always install on launch, ignoring the toggle.
// - Auto-update ON  → download + install immediately, then relaunch.
// - Auto-update OFF → show a persistent "update available" toast with an action.
//
// The Tauri plugins are imported lazily so the verdict/toast layer works even
// when the native updater feed is unavailable (e.g. an unsigned dev build): in
// that case we degrade to a "open downloads" toast rather than throwing.
export function AutoUpdater() {
	const getNode = useActiveNodeGetter();
	const ranRef = useRef(false);

	useEffect(() => {
		// Check exactly once per launch.
		if (ranRef.current) {
			return;
		}
		ranRef.current = true;

		const run = async () => {
			const target = toTarget(getNode());
			const verdict = await checkForUpdate(target);
			if (!verdict.update_available) {
				return;
			}

			// Forced updates ignore the user toggle: install on launch so nobody
			// can stay on an old build. `||` short-circuits, so the pref is only
			// read when forcing is off.
			const auto = FORCE_AUTO_UPDATE || (await getAutoUpdateEnabled(target));
			if (auto) {
				await installUpdate(verdict);
				return;
			}

			// Notify-only: persistent toast with an explicit install action.
			sileo.info({
				title: `Update available — v${verdict.latest}`,
				description:
					verdict.notes ?? "A new version of Ryu is ready to install.",
				duration: null,
				button: {
					title: "Update now",
					onClick: () => {
						installUpdate(verdict).catch(() => undefined);
					},
				},
			});
		};

		run().catch(() => undefined);
	}, [getNode]);

	return null;
}

function openDownloads(url: string) {
	window.open(url, "_blank", "noopener");
}

// Drive the native install through tauri-plugin-updater, surfacing progress via
// sileo. Falls back to a manual-download toast if the native feed is absent.
// Exported so other surfaces (e.g. the node selector's Core/Gateway update
// action) can trigger the same single app-wide install from Core's verdict.
export async function installUpdate(verdict: UpdateCheck) {
	const downloadsUrl =
		verdict.html_url ?? "https://ryu.com/downloads?ref=ryu-app";

	// Non-stable channels route through the Rust `install_update_from_channel`
	// command, which points the Tauri updater at that channel's own `latest.json`
	// feed (the JS updater below can only read the static Stable endpoint baked
	// into tauri.conf.json). The Stable path is left byte-identical below, so a
	// release user on the default channel behaves exactly as before. If the
	// command is unavailable (older Core-less shell) or fails, we fall through to
	// the manual-download fallback rather than trapping the user.
	const channel = getReleaseChannel();
	if (channel !== "stable") {
		const progressId = sileo.info({
			title: `Downloading ${channel} update v${verdict.latest}…`,
			description: "Ryu will restart once the update is installed.",
			duration: null,
		});
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const { relaunch } = await import("@tauri-apps/plugin-process");
			const installed = await invoke<boolean>("install_update_from_channel", {
				channel,
			});
			sileo.dismiss(progressId);
			if (installed) {
				sileo.success({
					title: "Update installed",
					description: "Restarting Ryu…",
					duration: 2000,
				});
				setTimeout(() => {
					relaunch().catch(() => undefined);
				}, 1500);
			} else {
				sileo.info({
					title: `No ${channel} update found`,
					description: "You're on the latest build for this channel.",
					duration: 4000,
				});
			}
		} catch {
			sileo.dismiss(progressId);
			sileo.info({
				title: `Update v${verdict.latest} available`,
				description: "Open the download page to update manually.",
				duration: null,
				button: {
					title: "Open downloads",
					onClick: () => {
						openDownloads(downloadsUrl);
					},
				},
			});
		}
		return;
	}

	const progressId = sileo.info({
		title: `Downloading update v${verdict.latest}…`,
		description: "Ryu will restart once the update is installed.",
		duration: null,
	});

	try {
		const { check } = await import("@tauri-apps/plugin-updater");
		const { relaunch } = await import("@tauri-apps/plugin-process");

		const update = await check();
		if (!update) {
			// Core saw a release but the signed Tauri feed isn't reachable yet
			// (typical in dev / before the release CI runs). Offer manual install.
			sileo.dismiss(progressId);
			sileo.info({
				title: `Update v${verdict.latest} available`,
				description: "Open the download page to update manually.",
				duration: null,
				button: {
					title: "Open downloads",
					onClick: () => {
						openDownloads(downloadsUrl);
					},
				},
			});
			return;
		}

		await update.downloadAndInstall();
		sileo.dismiss(progressId);
		sileo.success({
			title: "Update installed",
			description: "Restarting Ryu…",
			duration: 2000,
		});
		setTimeout(() => {
			relaunch().catch(() => undefined);
		}, 1500);
	} catch (err) {
		sileo.dismiss(progressId);
		sileo.error({
			title: "Update failed",
			description: err instanceof Error ? err.message : String(err),
			duration: null,
			button: {
				title: "Retry",
				onClick: () => {
					installUpdate(verdict).catch(() => undefined);
				},
			},
		});
	}
}
