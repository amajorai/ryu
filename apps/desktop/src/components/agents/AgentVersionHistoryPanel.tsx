import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import {
	VersionHistory,
	type VersionSource,
} from "@/src/components/versioning/VersionHistory.tsx";

interface AgentVersionHistoryPanelProps<TRestoreResult, TSnapshotResult> {
	currentValue: string;
	disabled?: boolean;
	onRestored?: () => void;
	source: VersionSource<TRestoreResult, TSnapshotResult>;
}

/** Complete Core-owned agent-definition history used by the editor's Versions tab. */
export function AgentVersionHistoryPanel<TRestoreResult, TSnapshotResult>({
	currentValue,
	disabled = false,
	onRestored,
	source,
}: AgentVersionHistoryPanelProps<TRestoreResult, TSnapshotResult>) {
	return (
		<SettingsSection
			caption="Checkpoints of model, tools, safety, persona and instructions. Never runs or credentials."
			title="Agent configuration history"
		>
			<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4">
				<div className="max-w-2xl">
					<p className="font-medium">Compare, test, and roll back</p>
					<p className="text-detail text-muted-foreground">
						Save a checkpoint, compare it with the current definition, or
						restore it.
					</p>
				</div>
				<VersionHistory
					currentValue={currentValue}
					disabled={disabled}
					onRestored={onRestored}
					source={source}
				/>
			</div>
		</SettingsSection>
	);
}
