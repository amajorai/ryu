import {
	AGENT_AVAILABILITY_OPTIONS,
	agentAvailabilityLabel,
	isAgentAvailabilityStatus,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import {
	type GamingSettings,
	getGamingSettings,
	getStreamingSettings,
	type StreamingSettings,
	saveGamingSettings,
	saveStreamingSettings,
} from "@/src/lib/api/presence.ts";
import {
	AFK_TIMEOUT_OPTIONS,
	type AfkTimeoutMinutes,
} from "@/src/lib/user-availability.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

function afkTimeoutSelectOptions(tl: LiteralMessage) {
	return AFK_TIMEOUT_OPTIONS.map((minutes) => ({
		label:
			minutes === 60
				? tl("After 1 hour")
				: tl("After {minutes} minutes", { minutes }),
		value: String(minutes),
	}));
}

/** General settings for human-input timing and AFK detection. */
export function AvailabilitySettings() {
	const tl = useLiteralMessages();
	const afkTimeoutOptions = afkTimeoutSelectOptions(tl);
	const node = useActiveNode();
	// Recreate node-owned controls whenever authority changes. An old pending
	// save must never update the state belonging to the newly selected node.
	const scopeSequence = useRef(0);
	const nodeScope = useMemo(() => {
		scopeSequence.current += 1;
		return scopeSequence.current;
	}, [node.url, node.token, node.userJwt]);
	const {
		detectedGame,
		detectedStreamingApp,
		settings,
		setAfkDetection,
		setAfkTimeout,
		setStatus,
		status,
		source,
	} = useUserAvailability();

	return (
		<SettingsSection
			caption="Away, Do not disturb, Gaming and Streaming keep agents working; their questions wait."
			title="Availability & prompts"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={AGENT_AVAILABILITY_OPTIONS}
							onValueChange={(value) => {
								if (isAgentAvailabilityStatus(value)) {
									setStatus(value);
								}
							}}
							value={settings.manualStatus}
						>
							<SelectTrigger
								appearance="editor-row"
								className="w-44 shrink-0"
								id="availability-manual-status-select"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{AGENT_AVAILABILITY_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={currentStatusSentence(
						tl,
						tl(agentAvailabilityLabel(status)),
						source,
						detectedGame,
						detectedStreamingApp
					)}
					settingsId="general.chats.manual-status"
					title="Manual status"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={settings.afkDetectionEnabled}
							id="availability-afk-detection-toggle"
							onCheckedChange={setAfkDetection}
						/>
					}
					description="An idle or unfocused window goes Away, and Online again when you return."
					settingsId="general.chats.afk-detection"
					title="Auto-away when inactive"
				/>
				<SettingsItem
					actions={
						<Select
							disabled={!settings.afkDetectionEnabled}
							items={afkTimeoutOptions}
							onValueChange={(value) => {
								const minutes = Number(value);
								if (
									AFK_TIMEOUT_OPTIONS.includes(
										/* SAFETY: The assertion only adapts includes to this numeric search value; the authored AFK_TIMEOUT_OPTIONS comparison below establishes membership. */ minutes as AfkTimeoutMinutes
									)
								) {
									/* SAFETY: The enclosing successful AFK_TIMEOUT_OPTIONS.includes comparison establishes this exact numeric value is an authored timeout. */ setAfkTimeout(
										minutes as AfkTimeoutMinutes
									);
								}
							}}
							value={String(settings.afkTimeoutMinutes)}
						>
							<SelectTrigger
								appearance="editor-row"
								className="w-44 shrink-0"
								id="availability-afk-timeout-select"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{afkTimeoutOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					settingsId="general.chats.afk-timeout"
					title="Auto-away after"
				/>
			</SettingsGroup>
			<GamingModeSettings
				detectedGame={detectedGame}
				key={`gaming:${nodeScope}`}
			/>
			<StreamingModeSettings
				detectedApp={detectedStreamingApp}
				key={`streaming:${nodeScope}`}
			/>
		</SettingsSection>
	);
}

function currentStatusSentence(
	tl: LiteralMessage,
	status: string,
	source: ReturnType<typeof useUserAvailability>["source"],
	detectedGame: string | null,
	detectedStreamingApp: string | null
): string {
	const runningApp = source === "stream" ? detectedStreamingApp : detectedGame;
	if ((source === "stream" || source === "game") && runningApp) {
		return tl("Currently {status} because {appName} is running.", {
			appName: runningApp,
			status,
		});
	}
	if (source === "stream") {
		return tl("Currently {status} from streaming app detection.", { status });
	}
	if (source === "game") {
		return tl("Currently {status} from game detection.", { status });
	}
	return source === "afk"
		? tl("Currently {status} from AFK detection.", { status })
		: tl("Currently {status} by your choice.", { status });
}

/** Split a comma- or newline-separated list of executable names. */
function parseProcessList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((name) => name.trim())
		.filter(Boolean);
}

/** Comma-separated executable list that saves when the field loses focus. */
function ProcessListInput({
	ariaLabel,
	disabled,
	id,
	onSave,
	placeholder,
	value,
}: {
	ariaLabel: string;
	disabled: boolean;
	id: string;
	onSave: (next: string[]) => void;
	placeholder: string;
	value: string[];
}) {
	const saved = value.join(", ");
	const [draft, setDraft] = useState(saved);
	useEffect(() => {
		setDraft(saved);
	}, [saved]);
	return (
		<Input
			aria-label={ariaLabel}
			className="w-56"
			disabled={disabled}
			id={id}
			onBlur={() => {
				const next = parseProcessList(draft);
				if (next.join(",") !== value.join(",")) {
					onSave(next);
				}
			}}
			onChange={(event) => setDraft(event.target.value)}
			placeholder={placeholder}
			size="settings-search"
			value={draft}
		/>
	);
}

/**
 * Gaming mode lives in Core: detection reads the node's process table and the
 * model pause stops Core's sidecars, so these preferences are node settings.
 */
function GamingModeSettings({ detectedGame }: { detectedGame: string | null }) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const url = node.url;
	const token = node.token;
	const userJwt = node.userJwt ?? null;
	const [gaming, setGaming] = useState<GamingSettings | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		getGamingSettings({ token, url, userJwt })
			.then((loaded) => {
				if (!cancelled) {
					setGaming(loaded);
					setUnavailable(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setUnavailable(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [token, url, userJwt]);

	const save = useCallback(
		async (patch: Partial<GamingSettings>) => {
			if (!gaming || savingRef.current) {
				return;
			}
			savingRef.current = true;
			setSaving(true);
			const next = { ...gaming, ...patch };
			setGaming(next);
			try {
				const saved = await saveGamingSettings({ token, url, userJwt }, next);
				setGaming(saved);
			} catch {
				setGaming(gaming);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[gaming, token, url, userJwt]
	);

	const disabled = !gaming || unavailable || saving;
	return (
		<SettingsGroup>
			<SettingsItem
				actions={
					<Switch
						checked={gaming?.detectionEnabled ?? false}
						disabled={disabled}
						id="availability-gaming-detection-toggle"
						onCheckedChange={(checked) => save({ detectionEnabled: checked })}
					/>
				}
				description={
					unavailable
						? "This node's Core does not support gaming mode yet. Update Ryu to use it."
						: detectedGame
							? tl(
									"Detected {gameName}. Ryu is in Gaming mode until it closes.",
									{ gameName: detectedGame }
								)
							: "Switch to Gaming while a game runs. Process names never leave this node."
				}
				settingsId="general.chats.gaming-detection"
				title="Detect games"
			/>
			<SettingsItem
				actions={
					<Switch
						checked={gaming?.freeLocalModels ?? true}
						disabled={disabled}
						id="availability-gaming-free-models-toggle"
						onCheckedChange={(checked) => save({ freeLocalModels: checked })}
					/>
				}
				description="Unload local models while Gaming is on; they reload when the game closes."
				settingsId="general.chats.gaming-free-models"
				title="Free memory for games"
			/>
			<SettingsItem
				actions={
					<ProcessListInput
						ariaLabel="Extra game executables"
						disabled={disabled || !gaming?.detectionEnabled}
						id="availability-gaming-processes-input"
						onSave={(extraProcesses) => save({ extraProcesses })}
						placeholder="mygame, emulator"
						value={gaming?.extraProcesses ?? []}
					/>
				}
				description="Executables Ryu misses, without .exe."
				settingsId="general.chats.gaming-processes"
				title="Extra games"
			/>
			<SettingsItem
				actions={
					<ProcessListInput
						ariaLabel="Executables that are not games"
						disabled={disabled || !gaming?.detectionEnabled}
						id="availability-gaming-ignored-input"
						onSave={(ignoredProcesses) => save({ ignoredProcesses })}
						placeholder="wallpaper64, obs64"
						value={gaming?.ignoredProcesses ?? []}
					/>
				}
				description="Apps that never switch on Gaming."
				settingsId="general.chats.gaming-ignored"
				title="Not games"
			/>
		</SettingsGroup>
	);
}

/** Streaming detection stays in Core so every Island suggestion uses the same privacy state. */
function StreamingModeSettings({
	detectedApp,
}: {
	detectedApp: string | null;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const url = node.url;
	const token = node.token;
	const userJwt = node.userJwt ?? null;
	const [streaming, setStreaming] = useState<StreamingSettings | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		getStreamingSettings({ token, url, userJwt })
			.then((loaded) => {
				if (!cancelled) {
					setStreaming(loaded);
					setUnavailable(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setUnavailable(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [token, url, userJwt]);

	const save = useCallback(
		async (patch: Partial<StreamingSettings>) => {
			if (!streaming || savingRef.current) {
				return;
			}
			savingRef.current = true;
			setSaving(true);
			const previous = streaming;
			const next = { ...streaming, ...patch };
			setStreaming(next);
			try {
				const saved = await saveStreamingSettings(
					{ token, url, userJwt },
					next
				);
				setStreaming(saved);
			} catch {
				setStreaming(previous);
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[streaming, token, url, userJwt]
	);

	const disabled = !streaming || unavailable || saving;
	return (
		<SettingsGroup>
			<SettingsItem
				actions={
					<Switch
						checked={streaming?.detectionEnabled ?? true}
						disabled={disabled}
						id="availability-streaming-detection-toggle"
						onCheckedChange={(checked) => save({ detectionEnabled: checked })}
					/>
				}
				description={
					unavailable
						? "This node's Core does not support Streaming mode yet. Update Ryu to use it."
						: detectedApp
							? tl(
									"{appName} is running. Connect event contents are withheld from models.",
									{ appName: detectedApp }
								)
							: "Switch to Streaming while a listed app runs. Connect event contents stay out of models."
				}
				settingsId="general.chats.streaming-detection"
				title="Detect streaming apps"
			/>
			<SettingsItem
				actions={
					<ProcessListInput
						ariaLabel="Streaming app process names"
						disabled={disabled || !streaming?.detectionEnabled}
						id="availability-streaming-apps-input"
						onSave={(apps) => save({ apps })}
						placeholder="obs64, Streamlabs, TikTokLiveStudio"
						value={streaming?.apps ?? []}
					/>
				}
				description="Process names from Task Manager; .exe is optional."
				settingsId="general.chats.streaming-apps"
				title="Streaming apps"
			/>
		</SettingsGroup>
	);
}
