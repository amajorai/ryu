import { z } from "zod";
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
} from "@ryu/ui/components/select.tsx";
import { useEffect, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import {
	DEFAULT_VOICE_PREFS,
	getVoiceInputPrefs,
	isVoiceEngine,
	setVoiceInputPrefs,
	VOICE_ENGINES,
	type VoiceEngine,
} from "@/src/lib/api/preferences.ts";
import {
	useVoicePreference,
	useVoicePreferenceScope,
	type VoicePreferenceAuthority,
	VoicePreferenceStatus,
} from "./voice-preference-state.tsx";

interface SidecarStatus {
	name: string;
	running: boolean;
}

// How often to refresh engine run status so it reflects installs/starts made
// elsewhere without reopening the screen.
const STATUS_POLL_MS = 5000;

const sidecarStatusResponseCodec: z.ZodType<SidecarStatus> = z
	.object({ name: z.string(), running: z.boolean() })
	.passthrough();
export function VoiceInputSettings() {
	const scope = useVoicePreferenceScope();
	return (
		<VoiceInputSettingsForTarget
			key={scope.id}
			resource={scope.resource}
			target={scope.target}
		/>
	);
}

function VoiceInputSettingsForTarget({
	target,
	resource,
}: {
	target: ApiTarget;
	resource: VoicePreferenceAuthority;
}) {
	const { prefs, persist, disabled, error, retry, pending } =
		useVoicePreference(
			target,
			DEFAULT_VOICE_PREFS,
			getVoiceInputPrefs,
			setVoiceInputPrefs,
			resource
		);
	const [statuses, setStatuses] = useState<SidecarStatus[]>([]);

	// Poll sidecar status so run state stays fresh after the engine is
	// installed/started elsewhere while this screen is open.
	useEffect(() => {
		let cancelled = false;
		const fetchStatus = () => {
			request<{ sidecars?: SidecarStatus[] }>(
				target,
				"/api/sidecar/status",
				{},
				z
					.object({ sidecars: z.array(sidecarStatusResponseCodec).optional() })
					.passthrough()
			)
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
	}, [target]);

	const handleEngine = (value: string) => {
		const entry =
			VOICE_ENGINES.find((e) => e.engine === value) ?? VOICE_ENGINES[0];
		// Switching engine also resets the model to that engine's bundled model.
		persist({ ...prefs, engine: entry.engine, model: entry.model });
	};

	const selectedEngine = VOICE_ENGINES.find((e) => e.engine === prefs.engine);
	// A cloud engine has no sidecar, so there is nothing to install or run and
	// nothing to report as stopped. Guarded rather than left to `find`: matching
	// `s.name === undefined` would be a nonsense lookup that happens to return
	// undefined today.
	const engineSidecar = selectedEngine?.sidecar
		? statuses.find((s) => s.name === selectedEngine.sidecar)
		: undefined;
	const engineRunning = selectedEngine?.sidecar
		? engineSidecar?.running === true
		: true;

	// Derived from the engine list, not hand-written: a hardcoded pair silently
	// rejected any engine added to `VOICE_ENGINES` — which is how the cloud slot
	// stayed unreachable while Core had supported it all along.
	// Base UI's Select hands back `string | null`; preserve that owner contract.
	const isEngine = (value: string | null): value is VoiceEngine =>
		isVoiceEngine(value);

	return (
		<SettingsSection
			caption="The push-to-talk shortcut and enable toggle live in the Island settings."
			title="Voice Recognition"
		>
			{error ? (
				// The shared status is a bare sentence + Retry; give it the card
				// surface and lay it out as one row instead of floating on the pane.
				<SettingsCard className="text-muted-foreground text-sm [&>[role=alert]]:flex [&>[role=alert]]:items-center [&>[role=alert]]:justify-between [&>[role=alert]]:gap-3">
					<VoicePreferenceStatus
						error={error}
						pending={pending}
						retry={retry}
					/>
				</SettingsCard>
			) : null}
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							disabled={disabled}
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
								aria-label="Voice Recognition engine"
								className="h-8 w-56"
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
							: "Not running. Install and start it from Services first."
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
							<SelectTrigger aria-label="Voice model" className="h-8 w-56">
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
