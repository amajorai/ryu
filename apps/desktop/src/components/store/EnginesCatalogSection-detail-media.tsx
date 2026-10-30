import { EngineFootnote } from "@ryu/blocks/desktop/store-engines.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { AudioCppEngineSettings } from "@/src/components/inference/AudioCppEngineSettings.tsx";
import { EngineLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { SttTranscriptionSettings } from "@/src/components/inference/SttTranscriptionSettings.tsx";
import { TtsEngineSettings } from "@/src/components/settings/TtsEngineSettings.tsx";
import type { VoiceEngineEntry } from "@/src/hooks/useVoiceEngines.ts";
import { LiveEngineInstallButton } from "./EnginesCatalogSection-install-button.tsx";
import {
	GROUP_LABELS,
	LAUNCH_SETTINGS_DESCRIPTIONS,
	type PendingKind,
	type RowState,
	unsupportedReason,
} from "./EnginesCatalogSection-model.ts";

export function RunAlongsideEngineDetail({
	kind,
	name,
	voiceEngines,
	voiceLoading,
	voiceError,
	installVoice,
	uninstallVoice,
	setVoiceRunning,
	rowState,
	runAction,
	canUpdateEngine,
}: {
	kind: "media" | "voice";
	name: string | undefined;
	voiceEngines: VoiceEngineEntry[];
	voiceLoading: boolean;
	voiceError: string | null;
	installVoice: (name: string, force?: boolean) => Promise<void>;
	uninstallVoice: (name: string) => Promise<void>;
	setVoiceRunning: (name: string, running: boolean) => Promise<void>;
	rowState: (name: string) => RowState;
	runAction: (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => Promise<void>;
	canUpdateEngine: (engine: { updateAvailable: boolean }) => boolean;
}) {
	const tl = useLiteralMessages();
	if (voiceLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}
	const engine = voiceEngines.find((e) => e.name === name);
	if (!engine) {
		return null;
	}
	const state = rowState(engine.name);
	const isInstalled = engine.installState === "installed";
	const busy = state.pending !== null;
	// Core decides support for the node it runs on (OS + arch + placed
	// binaries) and refuses to start an unsupported engine; mirror it here.
	const unsupported = !engine.supported;

	return (
		<ListingDetailShell
			actions={
				<>
					<LiveEngineInstallButton
						// Add and Update need support; Remove does not.
						busy={busy || (unsupported && !isInstalled)}
						disabledUninstall={!engine.runningKnown || engine.running}
						engineName={engine.name}
						hasUpdate={!unsupported && canUpdateEngine(engine)}
						installState={engine.installState}
						onInstall={() =>
							runAction(engine.name, "install", () =>
								installVoice(engine.name, canUpdateEngine(engine))
							)
						}
						onUninstall={() =>
							runAction(engine.name, "uninstall", () =>
								uninstallVoice(engine.name)
							)
						}
						pending={state.pending}
						statusKnown={engine.runningKnown}
					/>
					<div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
						{engine.runningKnown && engine.running ? (
							<Button
								disabled={busy}
								onClick={() =>
									void runAction(engine.name, "toggle", async () => {
										await setVoiceRunning(engine.name, false);
										await setVoiceRunning(engine.name, true);
									})
								}
								size="sm"
								variant="outline"
							>
								Restart
							</Button>
						) : null}
						<span>Running</span>
						<Switch
							aria-label={tl("Start or stop {displayName}", {
								displayName: engine.displayName,
							})}
							checked={engine.running}
							disabled={
								!isInstalled || busy || unsupported || !engine.runningKnown
							}
							onCheckedChange={() =>
								runAction(engine.name, "toggle", () =>
									setVoiceRunning(engine.name, !engine.running)
								)
							}
						/>
					</div>
				</>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Kind", value: GROUP_LABELS[kind] },
							{ label: "Engine ID", value: engine.name },
							{
								label: "Platforms",
								value: engine.platforms.join(", ") || "All",
							},
							{
								label: "Process",
								value: engine.runningKnown
									? engine.running
										? "Running"
										: "Stopped"
									: "Unknown",
							},
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					{...engineLogoProps(engine.name)}
					name={engine.displayName}
					statusIcons={
						<>
							{engine.runningKnown && engine.running ? (
								<StatusBadge kind="active" label="Running" tone="hero" />
							) : null}
							{unsupported ? (
								<StatusBadge
									kind="unavailable"
									label={unsupportedReason(
										engine.platforms,
										engine.unsupportedReason
									)}
									tone="hero"
								/>
							) : null}
						</>
					}
					tagline={engine.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Type", value: GROUP_LABELS[kind] },
						{
							label: "Install",
							value: isInstalled ? "Installed" : "Not installed",
						},
						{
							label: "Process",
							value: engine.runningKnown
								? engine.running
									? "Running"
									: "Stopped"
								: "Unknown",
						},
					]}
				/>
			}
		>
			<ListingSection title="How this engine behaves">
				<p className="text-muted-foreground text-sm leading-relaxed">
					Image and speech engines run alongside the active text engine. Use the
					toggle to start or stop this engine's sidecar process.
				</p>
			</ListingSection>
			{engine.name === "ryutts" ? (
				<ListingSection title="Text-to-speech defaults">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Choose the default speech engine and voice for desktop read-aloud
						and voice replies. These defaults are shared across the desktop app.
					</p>
					<TtsEngineSettings sectionTitle={null} />
				</ListingSection>
			) : null}
			{engine.name === "whispercpp" ? (
				<ListingSection title="Speech recognition settings">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Choose the CPU thread count and whisper-server flags for this
						transcription engine. If Core adopted an external server, its
						process flags remain controlled by that server's owner.
					</p>
					<SttTranscriptionSettings engineId="whispercpp" />
					<div className="mt-3">
						<EngineLaunchConfigSection engineId="whispercpp" />
					</div>
				</ListingSection>
			) : null}
			{engine.name === "whispercpp" ? (
				<ListingSection title="Core Parakeet settings">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Parakeet is a separate in-process STT path. Ryu stores these options
						for this engine, but its current inference library uses its own
						defaults.
					</p>
					<SttTranscriptionSettings
						adapterSupported={false}
						engineId="parakeet"
					/>
				</ListingSection>
			) : null}
			{engine.name === "whispercpp" ? (
				<ListingSection title="Gateway speech recognition settings">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Gateway routes speech recognition to its configured provider. Ryu
						saves this profile per node, but the current Gateway request path
						does not forward these recognition options.
					</p>
					<SttTranscriptionSettings
						adapterNote="Saved for Gateway speech recognition. The current Gateway adapter does not apply these fields to provider requests."
						adapterSupported={false}
						engineId="gateway"
					/>
				</ListingSection>
			) : null}
			{LAUNCH_SETTINGS_DESCRIPTIONS.has(engine.name) ? (
				<ListingSection title="Engine launch settings">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						{LAUNCH_SETTINGS_DESCRIPTIONS.get(engine.name)}
					</p>
					<EngineLaunchConfigSection engineId={engine.name} />
				</ListingSection>
			) : null}
			{engine.name === "audiocpp" ? (
				<ListingSection title="Audio runtime settings">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						These node-wide hardware settings apply to audio.cpp's speech
						recognition and voice generation models. If Core adopted an external
						server, hardware settings remain controlled by that server's owner.
					</p>
					<AudioCppEngineSettings />
					<div className="mt-4">
						<SttTranscriptionSettings
							adapterNote="audio.cpp receives language, temperature, prompt, and Additional fields. Other typed Whisper options are saved but skipped by this adapter."
							engineId="audiocpp"
						/>
					</div>
				</ListingSection>
			) : null}
			{unsupported && (
				<EngineFootnote>
					{unsupportedReason(engine.platforms, engine.unsupportedReason)}
				</EngineFootnote>
			)}
			{state.error && (
				<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
			)}
			{voiceError && (
				<EngineFootnote tone="destructive">{voiceError}</EngineFootnote>
			)}
		</ListingDetailShell>
	);
}
