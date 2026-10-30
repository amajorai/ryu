// apps/desktop/src/components/settings/PrivacySettings-healing.tsx
//
// Self-healing choices on the Privacy tab: load, writes, and the sub-page.

import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { getHealingConfig, setHealingConfig } from "@/src/lib/api/healing.ts";
import type { PrivacyRuntime } from "./PrivacySettings-runtime.ts";
import { waitPrivacyWrites } from "./PrivacySettings-writes.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function usePrivacyHealing({
	epoch,
	isCurrent,
	loadAttempt,
	pendingWrites,
	physicalResource,
	runMutation,
	setBusyKeys,
	target,
}: PrivacyRuntime) {
	const [healingEpoch, setHealingEpoch] = useState<number | null>(null);
	const [healingLoadError, setHealingLoadError] = useState<string | null>(null);
	const healingReady = healingEpoch === epoch;
	// Self-healing: master switch defaults ON, auto-decide defaults OFF (propose to
	// the inbox, the user disposes). Seeded to match Core's defaults.
	const [healEnabled, setHealEnabledState] = useState(true);
	const [healAutoDecide, setHealAutoDecideState] = useState(false);

	// Load the self-healing config independently (its own endpoint, not a pref).
	useEffect(() => {
		let cancelled = false;
		setBusyKeys([...pendingWrites.current]);
		setHealingEpoch(null);
		setHealingLoadError(null);
		waitPrivacyWrites(physicalResource)
			.then(() => {
				if (cancelled || !isCurrent()) {
					return null;
				}
				return getHealingConfig(target);
			})
			.then((cfg) => {
				if (cancelled || !isCurrent() || cfg === null) {
					return;
				}
				setHealEnabledState(cfg.enabled);
				setHealAutoDecideState(cfg.auto_decide);
				setHealingEpoch(epoch);
			})
			.catch(() => {
				if (cancelled || !isCurrent()) {
					return;
				}
				setHealingLoadError(
					"Couldn't load self-healing choices. Retry before changing them."
				);
			});
		return () => {
			cancelled = true;
		};
	}, [target, physicalResource, epoch, isCurrent, loadAttempt]);

	const handleHealEnabled = useCallback(
		(next: boolean) => {
			void runMutation(
				"healing",
				() => setHealingConfig(target, { enabled: next }),
				() => setHealEnabledState(next),
				() => setHealEnabledState(healEnabled),
				"Couldn't save your self-healing choice",
				healingReady
			);
		},
		[runMutation, target, healEnabled, healingReady]
	);
	const handleHealAutoDecide = useCallback(
		(next: boolean) => {
			void runMutation(
				"healing",
				() => setHealingConfig(target, { auto_decide: next }),
				() => setHealAutoDecideState(next),
				() => setHealAutoDecideState(healAutoDecide),
				"Couldn't save your auto-fix choice",
				healingReady
			);
		},
		[runMutation, target, healAutoDecide, healingReady]
	);

	return {
		handleHealAutoDecide,
		handleHealEnabled,
		healAutoDecide,
		healEnabled,
		healingLoadError,
		healingReady,
	};
}

export function HealingPage({
	busyKeys,
	healing,
}: {
	busyKeys: string[];
	healing: ReturnType<typeof usePrivacyHealing>;
}) {
	const {
		handleHealAutoDecide,
		handleHealEnabled,
		healAutoDecide,
		healEnabled,
		healingReady,
	} = healing;
	return (
		<SettingsSection
			caption="When a run fails, Ryu can diagnose why and propose a fix. By default the fix is proposed in your Inbox for you to approve. Turn on auto-fix to let it retry on its own (bounded to a couple of attempts). The diagnosis runs through your gateway."
			title="Self-healing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={healEnabled}
							disabled={!healingReady || busyKeys.includes("healing")}
							id="healing-enabled"
							onCheckedChange={handleHealEnabled}
						/>
					}
					description="On by default. Watch for failed runs and diagnose them; proposed fixes appear in your Inbox."
					title="Diagnose failed runs"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={healAutoDecide}
							disabled={
								!(healEnabled && healingReady) || busyKeys.includes("healing")
							}
							id="healing-auto-decide"
							onCheckedChange={handleHealAutoDecide}
						/>
					}
					description="Off by default. Apply the proposed fix and re-run automatically instead of asking first. Capped attempts and never re-heals its own retries."
					title="Auto-fix without asking"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
