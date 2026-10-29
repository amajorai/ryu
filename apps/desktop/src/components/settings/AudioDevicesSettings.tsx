// apps/desktop/src/components/settings/AudioDevicesSettings.tsx
//
// Settings UI for choosing the default microphone (drives voice input) and the
// default speaker (applied to playback via setSinkId where supported). Device
// labels require a one-time mic-permission grant, so we prompt on mount/refresh.

import { Mic01Icon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
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
	SettingsCard,
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
	const [deviceError, setDeviceError] = useState(false);

	const refresh = useCallback(async () => {
		setDeviceError(false);
		const granted = await ensureMicPermission();
		setPermission(granted ? "granted" : "denied");
		try {
			const { inputs: ins, outputs: outs } = await listAudioDevices();
			setInputs(ins);
			setOutputs(outs);
		} catch {
			setInputs([]);
			setOutputs([]);
			setDeviceError(true);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const handleMic = (value: string | null) => {
		if (value === null) {
			return;
		}
		setMicId(value);
		setDefaultMicId(value === SYSTEM_DEFAULT ? null : value);
	};

	const handleSpeaker = (value: string | null) => {
		if (value === null) {
			return;
		}
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
								className="h-8 w-56"
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
							<SelectTrigger aria-label="Default speaker" className="h-8 w-56">
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
				<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
					<p className="min-w-0 flex-1 text-muted-foreground text-sm">
						Microphone access is blocked, so device names are hidden. Turn it on
						in your system settings, then retry.
					</p>
					<div className="flex shrink-0 items-center gap-2">
						{canOpenMicrophoneSettings() && (
							<Button
								onClick={() => {
									openMicrophoneSettings().catch(() => undefined);
								}}
								size="sm"
								type="button"
								variant="outline"
							>
								Open settings
							</Button>
						)}
						<Button
							onClick={() => {
								refresh().catch(() => undefined);
							}}
							size="sm"
							type="button"
							variant="ghost"
						>
							Retry
						</Button>
					</div>
				</SettingsCard>
			)}
			{deviceError && permission !== "denied" && (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p
						aria-live="polite"
						className="text-muted-foreground text-sm"
						role="alert"
					>
						Couldn't list audio devices. Retry to check again.
					</p>
					<Button
						className="shrink-0"
						onClick={() => {
							refresh().catch(() => undefined);
						}}
						size="sm"
						type="button"
						variant="outline"
					>
						Retry
					</Button>
				</SettingsCard>
			)}
		</SettingsSection>
	);
}
