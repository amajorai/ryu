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
import { EngineInferenceSettings } from "@/src/components/inference/EngineInferenceSettings.tsx";
import { EngineLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { SpeechProcessingEngineSettings } from "@/src/components/inference/SpeechProcessingEngineSettings.tsx";
import type { useEngines } from "@/src/hooks/useEngines.ts";
import { EngineAccelerationSection } from "./EnginesCatalogSection-acceleration.tsx";
import { LiveEngineInstallButton } from "./EnginesCatalogSection-install-button.tsx";
import {
	ACCELERATION_ENGINE,
	GROUP_LABELS,
	type PendingKind,
	RESTARTABLE_CORE_CHAT_ENGINES,
	type RowState,
	unsupportedReason,
} from "./EnginesCatalogSection-model.ts";

export function TextEngineDetail({
	name,
	textEngines,
	textLoading,
	textError,
	installText,
	uninstallText,
	activateText,
	restartText,
	rowState,
	patchRow,
	runAction,
	canUpdateEngine,
}: {
	name: string | undefined;
	textEngines: ReturnType<typeof useEngines>["engines"];
	textLoading: boolean;
	textError: string | null;
	installText: (name: string, force?: boolean) => Promise<void>;
	uninstallText: (name: string) => Promise<void>;
	activateText: (name: string) => Promise<{ gatewayRefreshed: boolean }>;
	restartText: ReturnType<typeof useEngines>["restart"];
	rowState: (name: string) => RowState;
	patchRow: (name: string, patch: Partial<RowState>) => void;
	runAction: (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => Promise<void>;
	canUpdateEngine: (engine: { updateAvailable: boolean }) => boolean;
}) {
	const tl = useLiteralMessages();
	if (textLoading) {
		return <SkeletonRows rows={6} spacing="library" />;
	}
	const engine = textEngines.find((e) => e.name === name);
	if (!engine) {
		return null;
	}
	const state = rowState(engine.name);
	const isInstalled = engine.installState === "installed";
	const busy = state.pending !== null;
	const unsupported = !engine.supported;

	return (
		<ListingDetailShell
			actions={
				<>
					<LiveEngineInstallButton
						// An unsupported node can't Add or Update, but an installed
						// copy can still be removed to reclaim its disk space.
						busy={busy || (unsupported && !isInstalled)}
						disabledUninstall={engine.active}
						engineName={engine.name}
						hasUpdate={!unsupported && canUpdateEngine(engine)}
						installState={engine.installState}
						// Same button installs or updates: force only when the node
						// says a newer build is actually reachable, so a first
						// install keeps its cheap idempotent path.
						onInstall={() =>
							runAction(engine.name, "install", () =>
								installText(engine.name, canUpdateEngine(engine))
							)
						}
						onUninstall={() =>
							runAction(engine.name, "uninstall", () =>
								uninstallText(engine.name)
							)
						}
						pending={state.pending}
					/>
					<div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
						{engine.running &&
						RESTARTABLE_CORE_CHAT_ENGINES.has(engine.name) ? (
							<Button
								disabled={busy}
								onClick={() =>
									void runAction(engine.name, "toggle", () =>
										restartText(engine.name)
									)
								}
								size="sm"
								variant="outline"
							>
								Restart
							</Button>
						) : null}
						<span>Active engine</span>
						<Switch
							aria-label={tl("Set {displayName} as active engine", {
								displayName: engine.displayName,
							})}
							checked={engine.active}
							disabled={!isInstalled || busy || unsupported || engine.active}
							onCheckedChange={() =>
								runAction(engine.name, "toggle", async () => {
									if (engine.active) {
										return;
									}
									const swap = await activateText(engine.name);
									if (!swap.gatewayRefreshed) {
										patchRow(engine.name, { gatewayStale: true });
									}
								})
							}
						/>
					</div>
				</>
			}
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Kind", value: GROUP_LABELS.text },
							{ label: "Engine ID", value: engine.name },
							{
								label: "Platforms",
								value: engine.platforms?.join(", ") || "All",
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
							{engine.active ? <StatusBadge kind="active" tone="hero" /> : null}
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
						{ label: "Type", value: GROUP_LABELS.text },
						{
							label: "Install",
							value: isInstalled ? "Installed" : "Not installed",
						},
						{ label: "Binding", value: engine.active ? "Active" : "Idle" },
						{
							label: "Supported",
							value: engine.supported ? "Yes" : "No",
						},
					]}
				/>
			}
		>
			<ListingSection title="How this engine behaves">
				<p className="text-muted-foreground text-sm leading-relaxed">
					Text engines are mutually exclusive — only one can be the resident
					engine at a time. Toggling on swaps which engine Core binds local
					agents to.
				</p>
			</ListingSection>
			<ListingSection title="Advanced configuration">
				<EngineInferenceSettings engineId={engine.name} />
			</ListingSection>
			{engine.name === "llamacpp" ? (
				<ListingSection title="Embedding engine">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Llama.cpp runs a separate embedding server for semantic search.
						These defaults apply to that server across agents and Spaces.
					</p>
					<EngineLaunchConfigSection engineId="llamacpp-embed" />
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							disabled={rowState("llamacpp-embed").pending !== null}
							onClick={() =>
								void runAction("llamacpp-embed", "toggle", () =>
									restartText("llamacpp-embed")
								)
							}
							size="sm"
							variant="outline"
						>
							Restart embedding server
						</Button>
						{rowState("llamacpp-embed").error ? (
							<p className="text-status-destructive text-xs" role="alert">
								{rowState("llamacpp-embed").error}
							</p>
						) : null}
					</div>
				</ListingSection>
			) : null}
			{engine.name === "llamacpp" ? (
				<ListingSection title="Speech Processing defaults">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						S1-mini cleans up recognized text in Dictation. These settings are
						separate from Chat and shared with the Speech Processing layer on
						the Computer dialog's Voice & sandbox page.
					</p>
					<SpeechProcessingEngineSettings />
					<div className="mt-3">
						<EngineLaunchConfigSection engineId="llamacpp-speech" />
					</div>
				</ListingSection>
			) : null}
			{engine.name === "llamacpp" ? (
				<ListingSection title="Reranker and classifier servers">
					<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
						Llama.cpp also runs a reranker for Spaces search and a small
						classifier for routing and inspection. Each server keeps its own
						launch settings; changes apply the next time it starts.
					</p>
					<div className="flex flex-col gap-3">
						<EngineLaunchConfigSection engineId="llamacpp-rerank" />
						<EngineLaunchConfigSection engineId="llamacpp-classify" />
					</div>
				</ListingSection>
			) : null}
			{engine.name === ACCELERATION_ENGINE && isInstalled && (
				<EngineAccelerationSection />
			)}
			{unsupported && (
				<EngineFootnote>
					{unsupportedReason(engine.platforms, engine.unsupportedReason)}
				</EngineFootnote>
			)}
			{state.gatewayStale && (
				<EngineFootnote tone="amber">
					Engine active, but gateway routing was not refreshed.
				</EngineFootnote>
			)}
			{state.error && (
				<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
			)}
			{textError && (
				<EngineFootnote tone="destructive">{textError}</EngineFootnote>
			)}
		</ListingDetailShell>
	);
}
