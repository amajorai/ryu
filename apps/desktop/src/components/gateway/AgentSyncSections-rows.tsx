import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import { StatusText } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	AgentSyncProfile,
	AgentSyncStatus,
} from "@/src/lib/api/agent-sync.ts";
import { profileKey, providerLabel } from "./AgentSyncSections-providers.ts";

/** One muted sentence inside a card: the shared empty state for these lists. */
export function EmptyCard({ children }: { children: ReactNode }) {
	return (
		<SettingsCard className="py-3 text-muted-foreground text-sm">
			{children}
		</SettingsCard>
	);
}

/**
 * A load failure as a plain sentence with Retry beside it. The raw message (an
 * HTTP status, a schema issue list) stays available under "Details" instead of
 * being the headline. The alert wraps the button so assistive tech announces
 * the failure together with its recovery.
 */
export function LoadErrorRow({
	detail,
	loading,
	onRetry,
	summary,
}: {
	detail: string;
	loading: boolean;
	onRetry: () => void;
	summary: string;
}) {
	return (
		<div role="alert">
			<SettingsItem
				actions={
					<Button
						disabled={loading}
						onClick={onRetry}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				}
				title={summary}
			>
				<details className="text-muted-foreground text-xs">
					<summary className="cursor-pointer select-none">Details</summary>
					<span className="mt-1 block break-all font-mono">{detail}</span>
				</details>
			</SettingsItem>
		</div>
	);
}

export function ProfileList({
	profiles,
	selectedId,
	onSelect,
	onToggle,
}: {
	onSelect: (profile: AgentSyncProfile) => void;
	onToggle: (
		profile: AgentSyncProfile,
		key: "exportEnabled" | "importEnabled",
		value: boolean
	) => void;
	profiles: AgentSyncProfile[];
	selectedId: string | null;
}) {
	const tl = useLiteralMessages();
	if (profiles.length === 0) {
		return (
			<EmptyCard>
				No sync roots configured yet. Save a scanned folder to add one.
			</EmptyCard>
		);
	}
	return (
		<SettingsGroup>
			{profiles.map((profile) => {
				const label = providerLabel(profile.provider);
				return (
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								{profile.conflictCount > 0 ? (
									<StatusText tone="destructive">
										{tl("{conflictCount} conflicts", {
											conflictCount: profile.conflictCount,
										})}
									</StatusText>
								) : (
									<span className="text-muted-foreground text-sm">
										{profile.status}
									</span>
								)}
								<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
									<span>Import</span>
									<Switch
										aria-label={tl("Enable import for {label}", { label })}
										checked={profile.importEnabled}
										onCheckedChange={(checked) =>
											onToggle(profile, "importEnabled", checked)
										}
									/>
									<span>Export</span>
									<Switch
										aria-label={tl("Enable export for {label}", { label })}
										checked={profile.exportEnabled}
										onCheckedChange={(checked) =>
											onToggle(profile, "exportEnabled", checked)
										}
									/>
								</div>
								<Button
									onClick={() => onSelect(profile)}
									size="sm"
									variant="outline"
								>
									Use
								</Button>
							</div>
						}
						key={profileKey(profile)}
						title={
							profile.id === selectedId
								? tl("{label} · selected", { label })
								: label
						}
					>
						<span
							className="block truncate font-mono text-muted-foreground text-xs"
							title={profile.root}
						>
							{profile.root}
						</span>
					</SettingsItem>
				);
			})}
		</SettingsGroup>
	);
}

export function MutedValue({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground text-sm">{children}</span>;
}

export function SyncStatusSection({
	status,
}: {
	status: AgentSyncStatus | null;
}) {
	if (!status) {
		return null;
	}
	return (
		<SettingsSection title="Status">
			<SettingsGroup>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.profiles.length) ?? "—"}
						</MutedValue>
					}
					title="Profiles"
				/>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.bindings.length) ?? "—"}
						</MutedValue>
					}
					title="ACP bindings"
				/>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.activeOperations) ?? "—"}
						</MutedValue>
					}
					title="Active operations"
				/>
				<SettingsItem
					actions={
						<span className="font-mono text-muted-foreground text-xs">
							{status.nodeId}
						</span>
					}
					title="Node"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

/** A proof record row: label on top, the (often long, monospace) value beneath. */
export function ProofRow({ title, value }: { title: string; value: string }) {
	return (
		<SettingsItem title={title}>
			<span className="block break-all text-muted-foreground text-xs">
				{value}
			</span>
		</SettingsItem>
	);
}

export function ConflictList({
	onResolve,
	status,
}: {
	onResolve: (
		item: AgentSyncStatus["items"][number],
		resolution: "keep_external" | "keep_ryu"
	) => void;
	status: AgentSyncStatus | null;
}) {
	const tl = useLiteralMessages();
	const conflicts =
		status?.items.filter((item) => item.state === "conflict") ?? [];
	if (conflicts.length === 0) {
		return <EmptyCard>No conflicts.</EmptyCard>;
	}
	return (
		<>
			<p className="px-3 text-status-warning text-xs leading-snug">
				External changes are paused until reviewed.
			</p>
			<SettingsGroup>
				{conflicts.map((item) => (
					<SettingsItem
						actions={
							<div className="flex gap-2">
								<Button
									onClick={() => onResolve(item, "keep_external")}
									size="sm"
									variant="outline"
								>
									Keep external
								</Button>
								<Button
									onClick={() => onResolve(item, "keep_ryu")}
									size="sm"
									variant="outline"
								>
									Keep Ryu
								</Button>
							</div>
						}
						key={`${item.profileId}:${item.kind}:${item.sourceId}`}
						title="Conflict paused"
					>
						<span className="block truncate font-mono text-muted-foreground text-xs">
							{tl("{kind} · {sourceId} · revision {revision}", {
								kind: item.kind,
								revision: item.revision,
								sourceId: item.sourceId,
							})}
						</span>
					</SettingsItem>
				))}
			</SettingsGroup>
		</>
	);
}
