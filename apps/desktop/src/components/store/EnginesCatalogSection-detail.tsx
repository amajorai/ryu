import { LayerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import type { useEngines } from "@/src/hooks/useEngines.ts";
import { useOrgFeatures } from "@/src/hooks/useOrgFeatures.ts";
import type { SandboxBackendEntry } from "@/src/hooks/useSandboxBackends.ts";
import type { VoiceEngineEntry } from "@/src/hooks/useVoiceEngines.ts";
import { RunAlongsideEngineDetail } from "./EnginesCatalogSection-detail-media.tsx";
import { SandboxEngineDetail } from "./EnginesCatalogSection-detail-sandbox.tsx";
import { TextEngineDetail } from "./EnginesCatalogSection-detail-text.tsx";
import {
	hasEngineUpdate,
	type PendingKind,
	type RowState,
} from "./EnginesCatalogSection-model.ts";

export function EngineDetailPanel({
	selectedId,
	textEngines,
	voiceEngines,
	sandboxBackends,
	textLoading,
	voiceLoading,
	sandboxLoading,
	textError,
	voiceError,
	sandboxError,
	installText,
	uninstallText,
	activateText,
	restartText,
	installVoice,
	uninstallVoice,
	setVoiceRunning,
	selectSandbox,
	rowState,
	patchRow,
	runAction,
}: {
	selectedId: string | null;
	textEngines: ReturnType<typeof useEngines>["engines"];
	voiceEngines: VoiceEngineEntry[];
	sandboxBackends: SandboxBackendEntry[];
	textLoading: boolean;
	voiceLoading: boolean;
	sandboxLoading: boolean;
	textError: string | null;
	voiceError: string | null;
	sandboxError: string | null;
	installText: (name: string, force?: boolean) => Promise<void>;
	uninstallText: (name: string) => Promise<void>;
	activateText: (name: string) => Promise<{ gatewayRefreshed: boolean }>;
	restartText: ReturnType<typeof useEngines>["restart"];
	installVoice: (name: string, force?: boolean) => Promise<void>;
	uninstallVoice: (name: string) => Promise<void>;
	setVoiceRunning: (name: string, running: boolean) => Promise<void>;
	selectSandbox: (name: string) => Promise<void>;
	rowState: (name: string) => RowState;
	patchRow: (name: string, patch: Partial<RowState>) => void;
	runAction: (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => Promise<void>;
}) {
	// Org feature toggle: an organization can turn engine updates off. Core
	// refuses the forced reinstall; the panel just stops offering it.
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const canUpdateEngine = (engine: { updateAvailable: boolean }) =>
		hasEngineUpdate(engine) && orgFeatureEnabled("engines.update");
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LayerIcon} />
					</EmptyMedia>
					<EmptyTitle>No engine selected</EmptyTitle>
					<EmptyDescription>
						Pick an engine on the left to review its status and controls.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const [kind, name] = selectedId.split(":");

	if (kind === "text") {
		return (
			<TextEngineDetail
				activateText={activateText}
				canUpdateEngine={canUpdateEngine}
				installText={installText}
				name={name}
				patchRow={patchRow}
				restartText={restartText}
				rowState={rowState}
				runAction={runAction}
				textEngines={textEngines}
				textError={textError}
				textLoading={textLoading}
				uninstallText={uninstallText}
			/>
		);
	}

	if (kind === "media" || kind === "voice") {
		return (
			<RunAlongsideEngineDetail
				canUpdateEngine={canUpdateEngine}
				installVoice={installVoice}
				kind={kind}
				name={name}
				rowState={rowState}
				runAction={runAction}
				setVoiceRunning={setVoiceRunning}
				uninstallVoice={uninstallVoice}
				voiceEngines={voiceEngines}
				voiceError={voiceError}
				voiceLoading={voiceLoading}
			/>
		);
	}

	if (kind === "sandbox") {
		return (
			<SandboxEngineDetail
				name={name}
				rowState={rowState}
				runAction={runAction}
				sandboxBackends={sandboxBackends}
				sandboxError={sandboxError}
				sandboxLoading={sandboxLoading}
				selectSandbox={selectSandbox}
			/>
		);
	}

	return null;
}
