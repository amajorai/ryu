// Settings → Settings sync. The switch, the conflict policy, what is covered,
// and the conflict resolver.
//
// The design decision worth stating on the page rather than only in code: this
// syncs the DESKTOP CLIENT's own settings, and nothing else. Node configuration,
// credentials, workspace paths and device-specific picks are excluded by an
// allowlist, and the tab lists exactly what travels so the user does not have to
// take that on faith.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useState, useSyncExternalStore } from "react";
import {
	resetRemoteSettings,
	type SyncIdentity,
} from "@/src/lib/settings-sync/api.ts";
import {
	type ConflictPolicy,
	DEBOUNCE_MS,
	getActiveSyncIdentity,
	getConflictPolicy,
	getConflicts,
	getPendingCount,
	getSyncRevision,
	getSyncStatus,
	isSyncEnabled,
	lastSyncAt,
	resolveAllConflicts,
	resolveConflict,
	setConflictPolicy,
	setSyncEnabled,
	subscribeSyncState,
	syncPendingNow,
} from "@/src/lib/settings-sync/engine.ts";
import {
	currentPlatform,
	labelForKey,
	SYNC_GROUP_LABELS,
	SYNCABLE_KEYS,
	type SyncGroup,
} from "@/src/lib/settings-sync/keys.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Base UI resolves the CLOSED trigger's text from the root's `items` prop only —
// it never reads the rendered `<SelectItem>` children. Without this the trigger
// prints the raw policy value ("ask") instead of "Ask me every time".
const CONFLICT_POLICY_OPTIONS: { value: ConflictPolicy; label: string }[] = [
	{ value: "ask", label: "Ask me every time" },
	{ value: "download", label: "Always use the newer cloud copy" },
	{ value: "upload", label: "Always keep this machine's copy" },
];

const PLATFORM_LABEL = {
	darwin: "macOS",
	win32: "Windows",
	linux: "Linux",
} satisfies Record<ReturnType<typeof currentPlatform>, string>;

const STATUS_TEXT = {
	idle: "Up to date",
	syncing: "Syncing…",
	offline: "Sync incomplete",
	conflict: "Needs your decision",
} satisfies Record<ReturnType<typeof getSyncStatus>, string>;

function relativeTime(at: number): string {
	if (at === 0) {
		return "never";
	}
	const seconds = Math.round((Date.now() - at) / 1000);
	if (seconds < 60) {
		return "just now";
	}
	if (seconds < 3600) {
		return `${Math.round(seconds / 60)} min ago`;
	}
	if (seconds < 86_400) {
		return `${Math.round(seconds / 3600)} h ago`;
	}
	return formatDate(at);
}

/** A short, readable rendering of a stored value for the conflict list. */
function preview(value: string | null): string {
	if (value === null) {
		return "(not set)";
	}
	const trimmed = value.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

export function SettingsSyncTab() {
	const tl = useLiteralMessages();
	useSyncExternalStore(subscribeSyncState, getSyncRevision, getSyncRevision);
	const [forgetOpen, setForgetOpen] = useState(false);
	// The account the deletion is confirmed for, captured when the dialog opens.
	const [forgetIdentity, setForgetIdentity] = useState<SyncIdentity | null>(
		null
	);
	const [forgetting, setForgetting] = useState(false);

	const enabled = isSyncEnabled();
	const policy = getConflictPolicy();
	const status = getSyncStatus();
	const conflicts = getConflicts();
	const pending = getPendingCount();
	const statusText =
		status === "idle" && pending > 0
			? "Changes waiting to upload"
			: (STATUS_TEXT[status] ?? status);
	const platform = currentPlatform();

	const grouped = new Map<SyncGroup, string[]>();
	for (const entry of SYNCABLE_KEYS) {
		const list = grouped.get(entry.group) ?? [];
		list.push(entry.label);
		grouped.set(entry.group, list);
	}
	grouped.set("shortcuts", [
		`Every shortcut, stored separately per operating system (this machine uses the ${PLATFORM_LABEL[platform]} set)`,
	]);

	const handleSyncNow = async () => {
		await syncPendingNow();
		const result = getSyncStatus();
		if (result === "offline") {
			toast.error("Couldn't sync settings");
			return;
		}
		if (result === "conflict") {
			toast.error("Settings need your decision");
			return;
		}
		if (getPendingCount() > 0) {
			toast.message("Changes are still waiting to upload");
			return;
		}
		toast.success("Settings synced");
	};

	const handleForget = async () => {
		if (forgetting) {
			return;
		}
		setForgetting(true);
		try {
			const ok = await resetRemoteSettings(forgetIdentity);
			if (ok) {
				toast.success("Cloud copy deleted", {
					description: "The settings on this machine were not changed.",
				});
				setForgetOpen(false);
			} else {
				toast.error("Couldn't delete the cloud copy");
			}
		} finally {
			setForgetting(false);
		}
	};

	return (
		<div>
			<SettingsSection
				caption={tl(
					"Your settings follow you to every machine you sign in on. Changes upload {seconds} seconds after you stop.",
					{ seconds: Math.round(DEBOUNCE_MS / 1000) }
				)}
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={enabled}
								id="settings-sync-enabled"
								onCheckedChange={setSyncEnabled}
							/>
						}
						description="Never includes node config, API keys, folders or device picks."
						title="Sync My Settings Across Machines"
					/>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm">
								{enabled ? statusText : "Off"}
							</span>
						}
						title="Status"
					/>
					<SettingsItem
						actions={
							<Button
								disabled={!enabled || status === "syncing"}
								onClick={handleSyncNow}
								size="sm"
								variant="outline"
							>
								Sync now
							</Button>
						}
						description={
							pending > 0
								? tl(
										"{pending, plural, one {# change} other {# changes}} waiting to upload. Last synced {lastSynced}.",
										{ pending, lastSynced: relativeTime(lastSyncAt()) }
									)
								: tl("Last synced {lastSynced}.", {
										lastSynced: relativeTime(lastSyncAt()),
									})
						}
						title="Last Sync"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Pick a side only once you know which machine should win."
				title="When The Same Setting Changed In Two Places"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={CONFLICT_POLICY_OPTIONS}
								onValueChange={(value) => setConflictPolicy(value)}
								value={policy}
							>
								<SelectTrigger className="w-56" size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="ask">Ask me every time</SelectItem>
									<SelectItem value="download">
										Always use the newer cloud copy
									</SelectItem>
									<SelectItem value="upload">
										Always keep this machine's copy
									</SelectItem>
								</SelectContent>
							</Select>
						}
						title="Conflict Handling"
					/>
				</SettingsGroup>
			</SettingsSection>

			{conflicts.length > 0 ? (
				<SettingsSection
					caption="Each of these changed here and on another machine since they last agreed."
					headerAction={
						<div className="flex items-center gap-2">
							<Button
								onClick={() => resolveAllConflicts("remote")}
								size="sm"
								variant="ghost"
							>
								Use cloud for all
							</Button>
							<Button
								onClick={() => resolveAllConflicts("local")}
								size="sm"
								variant="ghost"
							>
								Keep this machine
							</Button>
						</div>
					}
					title={tl(
						"{count, plural, one {# setting needs} other {# settings need}} a decision",
						{ count: conflicts.length }
					)}
				>
					{conflicts.map((conflict) => (
						<div
							className="flex flex-col gap-2 border-border border-b py-3 last:border-b-0"
							key={conflict.key}
						>
							<span className="text-sm">{labelForKey(conflict.key)}</span>
							<div className="grid gap-4 sm:grid-cols-2">
								{(
									[
										["local", conflict.localAt, conflict.local, "Keep this"],
										["remote", conflict.remoteAt, conflict.remote, "Use cloud"],
									] as const
								).map(([side, at, value, action]) => (
									<div className="flex min-w-0 flex-col gap-1" key={side}>
										<span className="text-muted-foreground text-xs">
											{side === "local"
												? tl("This machine · {when}", {
														when: relativeTime(at),
													})
												: tl("Cloud · {when}", { when: relativeTime(at) })}
										</span>
										<span className="break-all font-mono text-xs">
											{preview(value)}
										</span>
										<Button
											className="mt-1 self-start"
											onClick={() => resolveConflict(conflict.key, side)}
											size="sm"
											variant="outline"
										>
											{action}
										</Button>
									</div>
								))}
							</div>
						</div>
					))}
				</SettingsSection>
			) : null}

			<SettingsSection
				caption="Everything else stays on this machine."
				title="What Gets Synced"
			>
				<SettingsGroup>
					{[...grouped.entries()].map(([group, labels]) => (
						<SettingsItem
							description={labels.join(" · ")}
							key={group}
							title={SYNC_GROUP_LABELS[group]}
						/>
					))}
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Removes the copy held for your account. This machine is left as it is."
				title="Cloud Copy"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								className="text-status-destructive"
								onClick={() => {
									setForgetIdentity(getActiveSyncIdentity());
									setForgetOpen(true);
								}}
								size="sm"
								variant="outline"
							>
								Delete cloud copy
							</Button>
						}
						title="Delete My Synced Settings"
					/>
				</SettingsGroup>
			</SettingsSection>

			<AlertDialog onOpenChange={setForgetOpen} open={forgetOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete your cloud settings?</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes the synced copy from your account.
							Settings on this machine remain unchanged. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={forgetting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={forgetting}
							loading={forgetting}
							onClick={() => void handleForget()}
							variant="destructive"
						>
							Delete cloud copy
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
