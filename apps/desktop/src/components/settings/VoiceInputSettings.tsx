// apps/desktop/src/components/settings/VoiceInputSettings.tsx
//
// Voice-input transcription settings for the island companion: the engine and
// its bundled model (plus its run status). The push-to-talk *shortcut* and the
// enable toggle live in the Island settings tab — they are island controls, not
// audio-bar controls. This section owns only the transcription engine choice.
// Values persist in Core under the shared `voice-input` preference key; the
// island reads + subscribes to them to pick the engine and route captured audio
// to Core's transcribe endpoint. Nothing is hardcoded — engine/model are
// swappable defaults routed through the one preferences key.

import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { useCallback, useEffect, useState } from "react";
import { request, toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_VOICE_PREFS,
	getVoiceInputPrefs,
	setVoiceInputPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
	type VoiceInputPrefs,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

interface SidecarStatus {
	name: string;
	running: boolean;
}

// How often to refresh engine run status so it reflects installs/starts made
// elsewhere without reopening the screen.
const STATUS_POLL_MS = 5000;

export function VoiceInputSettings() {
	const [prefs, setPrefs] = useState<VoiceInputPrefs>(DEFAULT_VOICE_PREFS);
	const [statuses, setStatuses] = useState<SidecarStatus[]>([]);

	// Load saved settings once on mount.
	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getVoiceInputPrefs(target).then((saved) => {
			if (!cancelled) {
				setPrefs(saved);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Poll sidecar status so run state stays fresh after the engine is
	// installed/started elsewhere while this screen is open.
	useEffect(() => {
		let cancelled = false;
		const fetchStatus = () => {
			const target = toTarget(useNodeStore.getState().getActiveNode());
			request<{ sidecars?: SidecarStatus[] }>(target, "/api/sidecar/status")
				.then((data) => {
					if (!cancelled) {
						setStatuses(data.sidecars ?? []);
					}
				})
				.catch(() => {
					// Status is best-effort; the picker still works without it.
				});
		};
		fetchStatus();
		const interval = setInterval(fetchStatus, STATUS_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Persist on every change, cross-process via Core.
	const persist = useCallback((next: VoiceInputPrefs) => {
		setPrefs(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		setVoiceInputPrefs(target, next).catch(() => undefined);
	}, []);

	const handleEngine = (value: string) => {
		const entry =
			VOICE_ENGINES.find((e) => e.engine === value) ?? VOICE_ENGINES[0];
		// Switching engine also resets the model to that engine's bundled model.
		persist({ ...prefs, engine: entry.engine, model: entry.model });
	};

	const selectedEngine = VOICE_ENGINES.find((e) => e.engine === prefs.engine);
	const engineSidecar = statuses.find(
		(s) => s.name === selectedEngine?.sidecar
	);
	const engineRunning = engineSidecar?.running ?? false;

	const isEngine = (value: string): value is VoiceEngine =>
		value === "whisper" || value === "parakeet";

	return (
		<SettingsSection
			caption="The push-to-talk shortcut and enable toggle live in the Island settings."
			title="Voice input"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={VOICE_ENGINES.map((e) => ({
								value: e.engine,
								label: e.label,
							}))}
							onValueChange={(v) => {
								if (isEngine(v)) {
									handleEngine(v);
								}
							}}
							value={prefs.engine}
						>
							<SelectTrigger
								aria-label="Voice engine"
								className="h-8 w-56 text-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{VOICE_ENGINES.map((e) => (
									<SelectItem key={e.engine} value={e.engine}>
										{e.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={
						engineRunning
							? "Running."
							: "Not running — install + start it from Services first."
					}
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={Mic01Icon}
								size={16}
							/>
							Engine
						</span>
					}
				/>

				<SettingsItem
					actions={
						<Select
							disabled
							items={[{ value: prefs.model, label: prefs.model }]}
							value={prefs.model}
						>
							<SelectTrigger
								aria-label="Voice model"
								className="h-8 w-56 text-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={prefs.model}>{prefs.model}</SelectItem>
							</SelectContent>
						</Select>
					}
					description="The bundled model this engine serves."
					title="Model"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
