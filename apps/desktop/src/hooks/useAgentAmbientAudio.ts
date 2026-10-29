import type { LiveActivityAudioSpec } from "@ryu/app-host/live-activity";
import { useEffect, useMemo, useState } from "react";
import {
	ambientAudioController,
	clampAmbientVolume,
} from "@/src/audio/ambient-agent-audio.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { pluginLiveSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginLiveActivity } from "@/src/lib/api/plugins.ts";
import {
	getPreference,
	subscribePreferenceChanges,
} from "@/src/lib/api/preferences.ts";
import { useWorkingAgent } from "@/src/store/useLiveActivityStore.ts";

const ENABLED_PREF_KEY = "ambient-elevator-enabled";
const VOLUME_PREF_KEY = "ambient-elevator-volume";
const DEFAULT_ENABLED = true;
const DEFAULT_VOLUME_PERCENT = 35;

function findAudioSpec(
	contributions: readonly PluginLiveActivity[]
): LiveActivityAudioSpec | undefined {
	const ordered = [...contributions].sort((a, b) =>
		`${a.plugin ?? ""}:${a.id}`.localeCompare(`${b.plugin ?? ""}:${b.id}`)
	);
	for (const contribution of ordered) {
		const audio = pluginLiveSpec(contribution)?.audio;
		if (audio?.src.trim()) {
			return audio;
		}
	}
	return undefined;
}

function parseEnabled(raw: string | null): boolean {
	if (raw === null) {
		return DEFAULT_ENABLED;
	}
	return raw !== "false" && raw !== "0";
}

function parseVolumePercent(raw: string | null): number {
	const parsed = raw === null ? DEFAULT_VOLUME_PERCENT : Number(raw);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_VOLUME_PERCENT;
	}
	return Math.min(100, Math.max(0, parsed));
}

/** Mount once from the desktop layout. It consumes the shared run store and
 * drives the shared controller, so N concurrent agent runs still produce one
 * playback stream with no per-run ownership or race. */
export function useAgentAmbientAudio(): void {
	const activeNode = useActiveNode();
	const target = useMemo(() => toTarget(activeNode), [activeNode]);
	const { live_activities } = usePluginContributions();
	const audioSpec = useMemo(
		() => findAudioSpec(live_activities),
		[live_activities]
	);
	const working = useWorkingAgent();
	const [enabled, setEnabled] = useState(DEFAULT_ENABLED);
	const [volumePercent, setVolumePercent] = useState(DEFAULT_VOLUME_PERCENT);
	const [settingsReady, setSettingsReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setSettingsReady(false);

		if (!audioSpec) {
			setEnabled(DEFAULT_ENABLED);
			setVolumePercent(DEFAULT_VOLUME_PERCENT);
			setSettingsReady(true);
			return () => {
				cancelled = true;
			};
		}

		Promise.all([
			getPreference(target, ENABLED_PREF_KEY),
			getPreference(target, VOLUME_PREF_KEY),
		]).then(([enabledRaw, volumeRaw]) => {
			if (cancelled) {
				return;
			}
			setEnabled(parseEnabled(enabledRaw));
			setVolumePercent(parseVolumePercent(volumeRaw));
			setSettingsReady(true);
		});

		return () => {
			cancelled = true;
		};
	}, [audioSpec?.src, target.token, target.url]);

	useEffect(
		() =>
			subscribePreferenceChanges((key, value) => {
				if (key === ENABLED_PREF_KEY) {
					setEnabled(parseEnabled(value));
				}
				if (key === VOLUME_PREF_KEY) {
					setVolumePercent(parseVolumePercent(value));
				}
			}),
		[]
	);

	useEffect(() => {
		ambientAudioController.sync({
			source: audioSpec?.src,
			playing: Boolean(audioSpec && settingsReady && enabled && working),
			volume: clampAmbientVolume(volumePercent / 100),
			loop: audioSpec?.loop ?? true,
		});
	}, [audioSpec, enabled, settingsReady, volumePercent, working]);

	useEffect(() => () => ambientAudioController.stop(), []);
}
