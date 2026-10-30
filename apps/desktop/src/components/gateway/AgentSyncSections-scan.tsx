import { SettingsNavRow } from "@ryu/blocks/desktop/settings-nav.tsx";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { ReactNode } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	AgentSyncScan,
	AgentSyncScanItem,
	SyncProvider,
} from "@/src/lib/api/agent-sync.ts";
import {
	HOME_PROVIDERS,
	pathSeparator,
} from "./AgentSyncSections-providers.ts";
import { EmptyCard, LoadErrorRow } from "./AgentSyncSections-rows.tsx";

export function RootDetection({
	home,
	homeError,
	homeLoading,
	onScan,
	onRetry,
	detected,
}: {
	detected: Set<string>;
	homeError: string | null;
	homeLoading: boolean;
	home: string | null;
	onScan: (path: string, provider: SyncProvider) => void;
	onRetry: () => void;
}) {
	if (!home) {
		if (homeError) {
			return (
				<LoadErrorRow
					detail={homeError}
					loading={homeLoading}
					onRetry={onRetry}
					summary="Couldn’t find this node’s home directory."
				/>
			);
		}
		return (
			<div role="status">
				<SettingsItem
					actions={homeLoading ? <Spinner className="size-4" /> : null}
					title="Detecting this node’s home directory…"
				/>
			</div>
		);
	}
	const separator = pathSeparator(home);
	return (
		<SettingsGroup>
			{HOME_PROVIDERS.map((provider) => {
				const path = `${home}${separator}${provider.home}`;
				return (
					<SettingsNavRow
						key={provider.value}
						onClick={() => onScan(path, provider.value)}
						title={
							<span className="flex items-center gap-2">
								<SvglIcon size={16} spec={provider.logo} />
								{provider.label}
							</span>
						}
						value={
							<span className="text-muted-foreground text-sm">
								{detected.has(path) ? "detected" : "not scanned"}
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/** A scrolling checklist inside one card; rows are plain labels, no inner box. */
function ChecklistCard({ children }: { children: ReactNode }) {
	return (
		<SettingsCard className="max-h-72 overflow-y-auto p-1.5">
			{children}
		</SettingsCard>
	);
}

export function ScanItems({
	items,
	selected,
	onToggle,
}: {
	items: AgentSyncScanItem[];
	onToggle: (item: AgentSyncScanItem, checked: boolean) => void;
	selected: Set<string>;
}) {
	if (items.length === 0) {
		return <EmptyCard>No supported setup items found.</EmptyCard>;
	}
	return (
		<ChecklistCard>
			{items.map((item) => {
				const key = `${item.kind}:${item.id}`;
				return (
					<label
						className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
						key={key}
					>
						<Checkbox
							checked={selected.has(key)}
							onCheckedChange={(checked) => onToggle(item, checked === true)}
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm" title={item.title}>
								{item.title}
							</span>
							<span className="block truncate font-mono text-muted-foreground text-xs">
								{item.kind} · {item.id}
							</span>
						</span>
						{item.already_exists ? (
							<span className="text-muted-foreground text-xs">Present</span>
						) : null}
					</label>
				);
			})}
		</ChecklistCard>
	);
}

export function ThreadItems({
	items,
	onToggle,
	selected,
}: {
	items: AgentSyncScan["threads"];
	onToggle: (id: string, checked: boolean) => void;
	selected: Set<string>;
}) {
	const tl = useLiteralMessages();
	if (items.length === 0) {
		return null;
	}
	return (
		<ChecklistCard>
			{items.map((thread) => (
				<label
					className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
					key={thread.id}
				>
					<Checkbox
						checked={selected.has(thread.id)}
						onCheckedChange={(checked) => onToggle(thread.id, checked === true)}
					/>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm" title={thread.title}>
							{thread.title}
						</span>
						<span className="block truncate font-mono text-muted-foreground text-xs">
							{tl("{sessionId} · {messageCount} messages", {
								messageCount: thread.message_count,
								sessionId: thread.native_session_id ?? thread.id,
							})}
						</span>
					</span>
				</label>
			))}
		</ChecklistCard>
	);
}
