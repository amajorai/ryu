// apps/desktop/src/components/settings/AudioDevicesSettings.tsx
//
// Settings UI for choosing the default microphone (drives voice input) and the
// default speaker (applied to playback via setSinkId where supported). Device
// labels require a one-time mic-permission grant, so we prompt on mount/refresh.

import { Mic01Icon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AudioDevice,
	ensureMicPermission,
	getDefaultMicId,
	getDefaultSpeakerId,
	listAudioDevices,
	setDefaultMicId,
	setDefaultSpeakerId,
	supportsSinkId,
} from "@/src/lib/audio/devices.ts";
import {
	canOpenMicrophoneSettings,
	openMicrophoneSettings,
} from "@/src/lib/os/permissions.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const SYSTEM_DEFAULT = "__system__";

export function AudioDevicesSettings() {
	const [inputs, setInputs] = useState<AudioDevice[]>([]);
	const [outputs, setOutputs] = useState<AudioDevice[]>([]);
	const [micId, setMicId] = useState<string>(
		getDefaultMicId() ?? SYSTEM_DEFAULT
	);
	const [speakerId, setSpeakerId] = useState<string>(
		getDefaultSpeakerId() ?? SYSTEM_DEFAULT
	);
	const [permission, setPermission] = useState<
		"unknown" | "granted" | "denied"
	>("unknown");

	const refresh = useCallback(async () => {
		const granted = await ensureMicPermission();
		setPermission(granted ? "granted" : "denied");
		const { inputs: ins, outputs: outs } = await listAudioDevices();
		setInputs(ins);
		setOutputs(outs);
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const handleMic = (value: string) => {
		setMicId(value);
		setDefaultMicId(value === SYSTEM_DEFAULT ? null : value);
	};

	const handleSpeaker = (value: string) => {
		setSpeakerId(value);
		setDefaultSpeakerId(value === SYSTEM_DEFAULT ? null : value);
	};

	const sinkSupported = supportsSinkId();

	const micOptions = useMemo(
		() => [
			{ value: SYSTEM_DEFAULT, label: "System default" },
			...inputs.map((d) => ({ value: d.deviceId, label: d.label })),
		],
		[inputs]
	);
	const speakerOptions = useMemo(
		() => [
			{ value: SYSTEM_DEFAULT, label: "System default" },
			...outputs.map((d) => ({ value: d.deviceId, label: d.label })),
		],
		[outputs]
	);

	return (
		<SettingsSection title="Audio devices">
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select items={micOptions} onValueChange={handleMic} value={micId}>
							<SelectTrigger
								aria-label="Default microphone"
								className="h-8 w-56 text-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{micOptions.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Used for voice input in chat."
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={Mic01Icon}
								size={16}
							/>
							Microphone
						</span>
					}
				/>
				<SettingsItem
					actions={
						<Select
							items={speakerOptions}
							onValueChange={handleSpeaker}
							value={speakerId}
						>
							<SelectTrigger
								aria-label="Default speaker"
								className="h-8 w-56 text-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{speakerOptions.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={
						sinkSupported
							? "Output device for audio playback."
							: "Saved, but this app may not be able to route audio to it."
					}
					title={
						<span className="flex items-center gap-2">
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={VolumeHighIcon}
								size={16}
							/>
							Speaker
						</span>
					}
				/>
			</SettingsGroup>

			{permission === "denied" && (
				<div className="space-y-2 px-3 pt-2">
					<p className="text-destructive text-xs">
						Microphone access is blocked, so device names are hidden. Turn it on
						in your system settings, then retry.
					</p>
					<div className="flex items-center gap-2">
						{canOpenMicrophoneSettings() && (
							<button
								className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
								onClick={() => {
									openMicrophoneSettings().catch(() => undefined);
								}}
								type="button"
							>
								Open settings
							</button>
						)}
						<button
							className="rounded-md px-2 py-1 text-xs hover:bg-muted/50"
							onClick={() => {
								refresh().catch(() => undefined);
							}}
							type="button"
						>
							Retry
						</button>
					</div>
				</div>
			)}
		</SettingsSection>
	);
}
