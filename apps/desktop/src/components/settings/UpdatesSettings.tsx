// Thin container for the Updates settings tab. Talks to Core's unified updater
// (version + shared auto-update toggle + manual check) and renders the shared
// presentational `UpdatesView` (`@ryu/blocks/desktop/updates`) — the same view
// the storyboard renders with mock data.

import { UpdatesView } from "@ryu/blocks/desktop/updates";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	checkForUpdate,
	FORCE_AUTO_UPDATE,
	getAutoUpdateEnabled,
	getVersionInfo,
	setAutoUpdateEnabled,
} from "@/src/lib/api/update.ts";
import {
	RELEASE_CHANNELS,
	useReleaseChannel,
} from "@/src/lib/release-channel.ts";

export function UpdatesSettings() {
	const getNode = useActiveNodeGetter();
	const [version, setVersion] = useState<string | null>(null);
	const [autoUpdate, setAutoUpdate] = useState<boolean>(true);
	const [checking, setChecking] = useState(false);

	useEffect(() => {
		const target = toTarget(getNode());
		let active = true;
		void (async () => {
			const [info, enabled] = await Promise.all([
				getVersionInfo(target).catch(() => null),
				getAutoUpdateEnabled(target),
			]);
			if (!active) {
				return;
			}
			setVersion(info?.ryu_version ?? null);
			setAutoUpdate(enabled);
		})();
		return () => {
			active = false;
		};
	}, [getNode]);

	const onToggle = async (next: boolean) => {
		setAutoUpdate(next);
		const ok = await setAutoUpdateEnabled(toTarget(getNode()), next);
		if (!ok) {
			setAutoUpdate(!next);
			sileo.error({ title: "Could not save the auto-update setting" });
		}
	};

	const onCheck = async () => {
		setChecking(true);
		try {
			const verdict = await checkForUpdate(toTarget(getNode()));
			// checkForUpdate fails soft to a "no update" verdict with empty
			// version strings (see update.ts). Treat that sentinel as a failed
			// check so we never reassure the user they're up to date when the
			// check never actually completed.
			const checkFailed = !(verdict.update_available || verdict.latest);
			if (checkFailed) {
				sileo.error({
					title: "Couldn't check for updates",
					description: "Check your connection and try again.",
				});
			} else if (verdict.update_available) {
				sileo.info({
					title: `Update available — v${verdict.latest}`,
					description: "A new version of Ryu is ready to install.",
				});
			} else {
				sileo.success({ title: "Ryu is up to date" });
			}
		} finally {
			setChecking(false);
		}
	};

	return (
		<div className="space-y-6">
			<UpdatesView
				autoUpdate={autoUpdate}
				checking={checking}
				forceAutoUpdate={FORCE_AUTO_UPDATE}
				onCheck={() => {
					onCheck().catch(() => undefined);
				}}
				onToggle={(next) => {
					onToggle(next).catch(() => undefined);
				}}
				version={version}
			/>
			<ReleaseChannelPicker />
		</div>
	);
}

/** Chooses the release channel (Canary / Nightly / Beta / Stable). The choice
 *  decides which per-channel updater feed the Tauri updater checks, so switching
 *  it changes which builds this install receives. */
function ReleaseChannelPicker() {
	const [channel, setChannel] = useReleaseChannel();

	return (
		<section className="space-y-3">
			<div>
				<h3 className="font-medium text-sm">Release channel</h3>
				<p className="text-muted-foreground text-xs">
					Which builds this install receives. More bleeding-edge channels update
					sooner but are less tested.
				</p>
			</div>
			<div className="space-y-1.5">
				{RELEASE_CHANNELS.map((option) => {
					const active = channel === option.channel;
					return (
						<button
							className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
								active
									? "border-primary bg-primary/5"
									: "border-border hover:bg-muted"
							}`}
							key={option.channel}
							onClick={() => setChannel(option.channel)}
							type="button"
						>
							<span
								aria-hidden="true"
								className={`mt-1 size-2 shrink-0 rounded-full ${
									active ? "bg-primary" : "bg-muted-foreground/30"
								}`}
							/>
							<span className="min-w-0 flex-1">
								<span className="block font-medium text-sm">
									{option.label}
								</span>
								<span className="block text-muted-foreground text-xs">
									{option.description}
								</span>
							</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}
