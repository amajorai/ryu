import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTargetGetter } from "@/src/hooks/useActiveNode.ts";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
import {
	DEFAULT_ISLAND_CONSENT,
	getIslandConsent,
	type IslandConsentPrefs,
	setIslandConsent,
} from "@/src/lib/api/preferences.ts";
import { IslandCaptureSections } from "./IslandSettings-capture-sections.tsx";
import { useIslandPlacementPrefs } from "./IslandSettings-placement-prefs.ts";
import { IslandPlacementSections } from "./IslandSettings-placement-sections.tsx";
import { useIslandVoicePrefs } from "./IslandSettings-voice-prefs.ts";
import { IslandVoiceSections } from "./IslandSettings-voice-sections.tsx";

/**
 * Settings for the island companion (a separate Electron overlay). Both controls
 * persist to Core's cross-process preferences store; the island reads them on
 * startup and subscribes to Core's SSE stream, so a change here re-configures the
 * live overlay (the offset re-docks it; the background recreates its window).
 */
export function IslandSettings() {
	// The dialog's scoped computer, or the active node outside one. Effects keep
	// `[]` deps: the node settings dialog remounts its content per computer.
	const getTarget = useActiveTargetGetter();
	// Shadow capture controls — the island surfaces Shadow's screen context, so
	// the most relevant toggles are mirrored here as well as in the Shadow tab.
	const shadow = useShadowCapture();
	const [preferenceWriteError, setPreferenceWriteError] = useState(false);
	const preferenceWriteVersions = useRef(new Map<string, number>());
	const persistPreferenceChange = useCallback(
		(
			key: string,
			write: Promise<boolean>,
			onFailure: () => void,
			onSuccess?: () => void
		) => {
			const version = (preferenceWriteVersions.current.get(key) ?? 0) + 1;
			preferenceWriteVersions.current.set(key, version);
			void write
				.then((saved) => {
					if (!saved) {
						throw new Error("Island preference was not saved");
					}
					if (preferenceWriteVersions.current.get(key) === version) {
						setPreferenceWriteError(false);
						onSuccess?.();
					}
				})
				.catch(() => {
					if (preferenceWriteVersions.current.get(key) !== version) {
						return;
					}
					onFailure();
					setPreferenceWriteError(true);
				});
		},
		[]
	);

	const placement = useIslandPlacementPrefs(getTarget, persistPreferenceChange);
	const voice = useIslandVoicePrefs(getTarget, persistPreferenceChange);

	// Privacy consent for the island companion. Mirrored cross-process via Core:
	// the island stays the authoritative hard gate but pushes/pulls this blob, so
	// these toggles (formerly only in the island's own removed Settings tab) are
	// editable here. `contextRead`/`proactive` are tri-state; an unanswered (`null`)
	// capability renders as off, and flipping a switch writes an explicit boolean.
	const [consent, setConsentState] = useState<IslandConsentPrefs>(
		DEFAULT_ISLAND_CONSENT
	);
	useEffect(() => {
		let cancelled = false;
		const target = getTarget();
		getIslandConsent(target).then((prefs) => {
			if (!cancelled) {
				setConsentState(prefs);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const writeConsent = (next: IslandConsentPrefs) => {
		const previous = consent;
		setConsentState(next);
		const target = getTarget();
		persistPreferenceChange(
			"island-consent",
			setIslandConsent(target, next),
			() => setConsentState(previous)
		);
	};

	return (
		<div className="space-y-6">
			{preferenceWriteError ? (
				<div
					className="rounded-lg border border-status-destructive/40 bg-status-destructive/10 p-3 text-sm text-status-destructive"
					role="alert"
				>
					Couldn't save Island setting. The previous value was restored. Choose
					the setting again to retry.
				</div>
			) : null}
			<IslandCaptureSections
				consent={consent}
				shadow={shadow}
				writeConsent={writeConsent}
			/>

			<IslandVoiceSections {...voice} />

			<IslandPlacementSections {...placement} />
		</div>
	);
}
