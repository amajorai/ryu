// Thin container for the Updates settings tab. Talks to Core's unified updater
// (version + shared auto-update toggle + manual check) and renders the shared
// presentational `UpdatesView` (`@ryu/blocks/desktop/updates`) — the same view
// the storyboard renders with mock data.

import { UpdatesView } from "@ryu/blocks/desktop/updates.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	updateToastBody,
	updateToastId,
} from "@/src/components/updater/ReleaseNotes.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getNodeTimeZone,
	NODE_TIME_ZONES,
	type NodeTimeZone,
	setNodeTimeZone,
} from "@/src/lib/api/node-timezone.ts";
import {
	checkForUpdate,
	getAutoUpdateEnabled,
	getVersionInfo,
	setAutoUpdateEnabled,
	updateCheckFailed,
} from "@/src/lib/api/update.ts";
import {
	AVAILABLE_RELEASE_CHANNELS,
	type ReleaseChannel,
	useReleaseChannel,
} from "@/src/lib/release-channel.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function UpdatesSettings() {
	const tl = useLiteralMessages();
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
				getAutoUpdateEnabled(target).catch(() => true),
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
		const previous = autoUpdate;
		setAutoUpdate(next);
		try {
			const ok = await setAutoUpdateEnabled(toTarget(getNode()), next);
			if (ok) {
				return;
			}
			setAutoUpdate(previous);
			sileo.error({ title: "Could not save the auto-update setting" });
		} catch {
			setAutoUpdate(previous);
			sileo.error({ title: "Could not save the auto-update setting" });
		}
	};

	const onCheck = async () => {
		setChecking(true);
		try {
			// Deliberately UNCLAMPED: this tab governs the NODE's Core/Gateway
			// binaries, and a self-hosted or shared node has no lifetime owner to
			// withhold builds from. So no verdict here is ever restricted, and there
			// is no window notice or restricted branch to add below.
			const verdict = await checkForUpdate(toTarget(getNode()));
			// A failed check surfaces as either the fail-soft sentinel (empty
			// version strings, see update.ts) or Core's fail-open verdict with an
			// `error` field. Both must never read as "you're up to date".
			if (updateCheckFailed(verdict)) {
				sileo.error({
					title: "Couldn't check for updates",
					description: verdict.error ?? "Check your connection and try again.",
				});
			} else if (verdict.update_available) {
				toast.info({
					title: tl("Update available — v{latest}", { latest: verdict.latest }),
					// Deliberately NOT gated on the app's own version the way the App
					// Updates tab is: this tab governs the NODE's Core/Gateway binaries,
					// so `verdict.current` — the answering Core's version — is exactly
					// the right thing to compare, even when this app bundle is newer.
					description: updateToastBody({
						notes: verdict.notes,
						htmlUrl: verdict.html_url,
						fallback: "A new version of Ryu is ready to install.",
					}),
					id: updateToastId(verdict.latest),
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
				onCheck={() => {
					onCheck().catch(() => undefined);
				}}
				onToggle={(next) => {
					onToggle(next).catch(() => undefined);
				}}
				version={version}
			/>
			<ReleaseChannelPicker />
			<NodeTimeZonePicker />
		</div>
	);
}

/**
 * The sentinel for "no override" — clearing the field, not picking a zone.
 *
 * A separate option rather than an empty value because the two are different
 * decisions: "follow whatever the machine reports" is the default a correctly
 * configured node should sit on, and it has to stay pickable after someone has
 * set an override.
 */
const FOLLOW_NODE = "__follow_node__";

const TIME_ZONE_ITEMS = [
	{ value: FOLLOW_NODE, label: "Follow the node" },
	...NODE_TIME_ZONES.map((zone) => ({ value: zone, label: zone })),
];

/**
 * The zone a managed node's quiet hour is measured in — the hour a deferred
 * update installs and a deferred resize powers the machine off.
 *
 * PER NODE, NOT PER ORG. An org with a node in Frankfurt and another in
 * Singapore has two different nights; one org-level zone would schedule a
 * restart into one of the two working days every time.
 *
 * Renders NOTHING unless the active node is a managed one carrying both ids.
 * The zone lives on a `ProvisionedServer` row, so a local, LAN, mesh — or
 * adopted/resumed — node has nowhere to store it, and a picker that can never
 * save is worse than no picker. `!isLocalNode` would be the wrong predicate
 * here: it admits LAN and mesh nodes too.
 */
export function NodeTimeZonePicker() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const orgId = node.orgId ?? null;
	const serverId = node.serverId ?? null;
	const [zone, setZone] = useState<NodeTimeZone | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!(orgId && serverId)) {
			setZone(null);
			return;
		}
		let active = true;
		void (async () => {
			try {
				const current = await getNodeTimeZone(orgId, serverId);
				if (active) {
					setZone(current);
					setError(null);
				}
			} catch (err) {
				// A node whose row cannot be read is not an error worth shouting
				// about — the section simply does not render. Reading is
				// member-level, so this is a transport failure, not a permission one.
				if (active) {
					setZone(null);
					setError(err instanceof Error ? err.message : String(err));
				}
			}
		})();
		return () => {
			active = false;
		};
	}, [orgId, serverId]);

	if (!(orgId && serverId && zone)) {
		return null;
	}

	const save = async (next: string) => {
		setSaving(true);
		try {
			const updated = await setNodeTimeZone(
				orgId,
				serverId,
				next === FOLLOW_NODE ? null : next
			);
			setZone(updated);
			setError(null);
		} catch (err) {
			// Writing needs org admin. Surfacing the server's own sentence is what
			// tells a plain member why the control bounced back.
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	// The override governs what the CONTROL PLANE schedules — resizes. It does
	// NOT reach this node's own deferred Core/Gateway update: `set_pending` in
	// `apps/core/src/update/schedule.rs` computes the hour from the machine's own
	// clock (TZ, /etc/timezone, /etc/localtime), and the zone travels one way
	// only, node → control plane, on the resolve handshake. So when the two
	// disagree, saying "restarts use 03:00 in <override>" would promise a quiet
	// hour that the update path lands eight hours away from — the exact failure
	// this whole feature exists to remove, restated as a settings caption.
	const overrideDiverges =
		zone.timeZone !== null &&
		zone.detectedTimeZone !== null &&
		zone.timeZone !== zone.detectedTimeZone;

	return (
		<SettingsSection
			caption={
				// The EFFECTIVE zone, not the override — the override is null on a
				// node that is correctly following its own clock, so rendering it
				// directly would render a blank.
				tl("Scheduled resizes use 03:00 in {timeZone}.", {
					timeZone: zone.effectiveTimeZone,
				})
			}
			title="Quiet hour"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							disabled={saving}
							items={TIME_ZONE_ITEMS}
							onValueChange={(v) => {
								save(String(v)).catch(() => undefined);
							}}
							value={zone.timeZone ?? FOLLOW_NODE}
						>
							<SelectTrigger
								appearance="editor-row"
								className="w-56 shrink-0"
								id="node-time-zone-select"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={FOLLOW_NODE}>
									{zone.detectedTimeZone
										? tl("Follow the node ({timeZone})", {
												timeZone: zone.detectedTimeZone,
											})
										: "Follow the node (not reported yet)"}
								</SelectItem>
								{NODE_TIME_ZONES.map((option) => (
									<SelectItem key={option} value={option}>
										{option}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Which night this node's scheduled resizes run in. Following the node is usually right — a machine in Frankfurt already knows it is in Frankfurt."
					title="Time zone"
				/>
				{overrideDiverges ? (
					<SettingsItem
						description={tl(
							"Deferred Core and Gateway updates are scheduled by the node itself, from its own clock — those still run at 03:00 {detectedTimeZone}, not {overrideTimeZone}. Only resizes, which the control plane performs, follow the override.",
							{
								detectedTimeZone: zone.detectedTimeZone,
								overrideTimeZone: zone.timeZone,
							}
						)}
						title="Updates keep the node's own night"
					/>
				) : null}
				{error ? (
					<SettingsItem description={error} title="Couldn't save" />
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}

/** Chooses the release channel (Canary / Nightly / Beta / Stable; Beta / Stable
 *  in Ryu Bot, which has no nightly or canary builds). The choice decides which
 *  per-channel updater feed the Tauri updater checks, so switching it changes
 *  which builds this install receives. */
const RELEASE_CHANNEL_ITEMS = AVAILABLE_RELEASE_CHANNELS.map((option) => ({
	value: option.channel,
	label: option.label,
}));

export function ReleaseChannelPicker() {
	const [channel, setChannel] = useReleaseChannel();

	return (
		<SettingsSection
			caption="More bleeding-edge channels update sooner but are less tested."
			title="Release channel"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select<ReleaseChannel>
							items={RELEASE_CHANNEL_ITEMS}
							onValueChange={(v) => setChannel(v)}
							value={channel}
						>
							<SelectTrigger
								appearance="editor-row"
								className="w-56 shrink-0"
								id="release-channel-select"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{AVAILABLE_RELEASE_CHANNELS.map((option) => (
									<SelectItem key={option.channel} value={option.channel}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Which builds this install receives. Switching changes which per-channel updater feed Ryu checks."
					title="Channel"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
