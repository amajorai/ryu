import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	SettingsCard,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	AgentSyncScan,
	AgentSyncScanItem,
} from "@/src/lib/api/agent-sync.ts";
import type { ImportSelection } from "@/src/lib/api/import.ts";
import { ScanItems, ThreadItems } from "./AgentSyncSections-scan.tsx";

/** The scanned source, its setup items, native threads, and warnings. */
export function ImportScanPreview({
	runImport,
	runThreadImport,
	scan,
	selected,
	selectedItems,
	selectedThreads,
	toggleSelectedItem,
	toggleSelectedThread,
	working,
}: {
	runImport: (dryRun: boolean) => Promise<void>;
	runThreadImport: () => Promise<void>;
	scan: AgentSyncScan;
	selected: Set<string>;
	selectedItems: ImportSelection[];
	selectedThreads: Set<string>;
	toggleSelectedItem: (item: AgentSyncScanItem, checked: boolean) => void;
	toggleSelectedThread: (id: string, checked: boolean) => void;
	working: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<SettingsSection
				caption={tl(
					"{itemCount} setup items and {threadCount} native threads detected.",
					{
						itemCount: String(scan.items.length),
						threadCount: String(scan.threads.length),
					}
				)}
				title="Import preview"
			>
				<SettingsItem
					actions={
						<span className="text-right text-muted-foreground text-sm">
							{tl(
								"{provider} · {threads, select, native {native threads readable} other {bundle-only threads}} · ACP {acp, select, resume {resume} other {replay fallback}}",
								{
									acp:
										scan.capabilities.acpLoadResume === true
											? "resume"
											: "replay",
									provider: scan.provider,
									threads: scan.capabilities.nativeThreads
										? "native"
										: "bundle",
								}
							)}
						</span>
					}
					title="Source"
				/>
			</SettingsSection>

			<SettingsSection
				headerAction={
					<div className="flex gap-2">
						<Button
							disabled={working || selectedItems.length === 0}
							onClick={() => void runImport(true)}
							size="sm"
							variant="outline"
						>
							Preview selected
						</Button>
						<Button
							disabled={working || selectedItems.length === 0}
							onClick={() => void runImport(false)}
							size="sm"
							variant="outline"
						>
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
							Import selected
						</Button>
					</div>
				}
				title="Setup items"
			>
				<ScanItems
					items={scan.items}
					onToggle={toggleSelectedItem}
					selected={selected}
				/>
			</SettingsSection>

			{scan.threads.length > 0 ? (
				<SettingsSection
					headerAction={
						<Button
							disabled={working || !scan.agentId || selectedThreads.size === 0}
							onClick={() => void runThreadImport()}
							size="sm"
							variant="outline"
						>
							Import selected threads
						</Button>
					}
					title="Native threads"
				>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm">
								{scan.agentId ? "ACP-backed import" : "Agent unavailable"}
							</span>
						}
						title="Import path"
					/>
					<ThreadItems
						items={scan.threads}
						onToggle={toggleSelectedThread}
						selected={selectedThreads}
					/>
				</SettingsSection>
			) : null}

			{scan.warnings.length > 0 ? (
				<SettingsSection title="Review before cutover">
					<SettingsCard className="flex flex-col gap-1.5">
						{scan.warnings.map((warning) => (
							<p className="text-sm text-status-warning" key={warning}>
								{warning}
							</p>
						))}
					</SettingsCard>
				</SettingsSection>
			) : null}
		</>
	);
}
