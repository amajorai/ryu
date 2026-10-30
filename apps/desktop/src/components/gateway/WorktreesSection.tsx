import { Folder03Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayGovernance,
	type GatewayGovernanceSnapshot,
	type GovernanceScope,
	isGovernanceFieldLocked,
	updateGatewayGovernance,
	type WorktreeGovernanceSettings,
} from "@/src/lib/api/governance.ts";
import {
	getThreadWorktreeIsolationDefault,
	setThreadWorktreeIsolationDefault,
} from "@/src/lib/api/thread-worktree-preference.ts";
import {
	DEFAULT_WORKTREE_SETTINGS,
	resolveWorktreeSetting,
} from "./developer-settings.ts";
import {
	GovernanceScopeSwitcher,
	type GovernanceView,
} from "./GovernanceScopeSwitcher.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

const queryKey = (target: ApiTarget) => [
	"gateway-governance",
	target.url,
	target.token,
];

const isolationPreferenceQueryKey = (target: ApiTarget) => [
	"thread-worktree-isolation-default",
	target.url,
	target.token,
];

const writeScopeFor = (
	view: GovernanceView
): Extract<GovernanceScope, "node" | "user"> | null => {
	if (view === "node") {
		return "node";
	}
	if (view === "effective" || view === "user") {
		return "user";
	}
	return null;
};

const scopePriority = {
	node: 0,
	organization: 1,
	team: 2,
	user: 3,
} satisfies Record<GovernanceScope, number>;

const visibleAtScope = (view: GovernanceView, scope: GovernanceScope) =>
	view === "effective" || scopePriority[scope] <= scopePriority[view];

// A Worktree setting row. The description becomes the iOS footer caption under
// the row's card; the lock note and validation error stay inside the card.
function WorktreeRow({
	actions,
	description,
	error,
	locked = false,
	title,
}: {
	actions: ReactNode;
	description: string;
	error?: { id: string; message: string };
	locked?: boolean;
	title: string;
}) {
	return (
		<SettingsItem actions={actions} description={description} title={title}>
			{locked ? (
				<p className="text-muted-foreground text-xs">
					Locked by your organization’s administrator.
				</p>
			) : null}
			{error ? (
				<p
					className="text-status-destructive text-xs"
					id={error.id}
					role="alert"
				>
					{error.message}
				</p>
			) : null}
		</SettingsItem>
	);
}

export function WorktreesSection({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const [view, setView] = useState<GovernanceView>("effective");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState(false);
	const [autoDeleteLimitError, setAutoDeleteLimitError] = useState<
		string | null
	>(null);
	const [pendingSave, setPendingSave] = useState<{
		scope: Extract<GovernanceScope, "node" | "user">;
		values: WorktreeGovernanceSettings;
	} | null>(null);
	const [inputRevision, setInputRevision] = useState(0);
	const [isolationSaving, setIsolationSaving] = useState(false);
	const [isolationSaveError, setIsolationSaveError] = useState(false);
	const query = useQuery({
		queryKey: queryKey(target),
		queryFn: ({ signal }) => fetchGatewayGovernance(target, signal),
	});
	const isolationQuery = useQuery({
		queryKey: isolationPreferenceQueryKey(target),
		queryFn: () => getThreadWorktreeIsolationDefault(target),
	});
	const snapshot = query.data;
	const writeScope = writeScopeFor(view);
	const displayedSnapshot: GatewayGovernanceSnapshot = {
		layers:
			snapshot?.layers.filter((layer) => visibleAtScope(view, layer.scope)) ??
			[],
		schemaVersion: 1,
	};
	const selectedLayer = snapshot?.layers.find(
		(layer) => layer.scope === writeScope
	);
	const localSettings = selectedLayer?.values.worktrees ?? {};
	const effective = <Key extends keyof WorktreeGovernanceSettings>(key: Key) =>
		resolveWorktreeSetting(displayedSnapshot, key)?.value ??
		DEFAULT_WORKTREE_SETTINGS[key];
	const disabled =
		!snapshot ||
		query.isPending ||
		query.isError ||
		!writeScope ||
		(writeScope === "node" && !canConfigure) ||
		saving;
	// Organization/team locks make a field read-only for the user layer.
	const isLocked = (key: keyof WorktreeGovernanceSettings) =>
		writeScope === "user" &&
		isGovernanceFieldLocked(snapshot, `worktrees.${key}`);

	const save = async (
		scope: Extract<GovernanceScope, "node" | "user">,
		values: WorktreeGovernanceSettings
	) => {
		setSaveError(false);
		setPendingSave(null);
		setSaving(true);
		try {
			const next = await updateGatewayGovernance(
				target,
				"worktrees",
				scope,
				values
			);
			queryClient.setQueryData(queryKey(target), next);
		} catch {
			setPendingSave({ scope, values });
			setSaveError(true);
			setInputRevision((revision) => revision + 1);
		} finally {
			setSaving(false);
		}
	};

	const update = (patch: WorktreeGovernanceSettings) => {
		if (!(writeScope && snapshot) || query.isError || query.isPending) {
			return;
		}
		void save(writeScope, { ...localSettings, ...patch });
	};

	const retrySave = () => {
		if (pendingSave) {
			void save(pendingSave.scope, pendingSave.values);
		}
	};

	const updateIsolationDefault = async (enabled: boolean) => {
		setIsolationSaveError(false);
		setIsolationSaving(true);
		try {
			await setThreadWorktreeIsolationDefault(target, enabled);
			queryClient.setQueryData(isolationPreferenceQueryKey(target), enabled);
		} catch {
			setIsolationSaveError(true);
		} finally {
			setIsolationSaving(false);
		}
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={"Filesystem paths belong to the node that owns them."}
					>
						{"Worktrees keep agent changes out of the project folder."}
					</CaptionInfo>
				}
				title="Worktrees"
			>
				{query.isPending ? (
					<SettingsNotice role="status">
						Loading Worktree settings…
					</SettingsNotice>
				) : null}
				{query.isError ? (
					<SettingsNotice
						action={
							<Button
								onClick={() => void query.refetch()}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						role="alert"
					>
						We couldn’t load Worktree settings. Try again before editing them.
					</SettingsNotice>
				) : null}
				{saveError ? (
					<SettingsNotice
						action={
							<Button
								disabled={saving}
								onClick={retrySave}
								size="sm"
								variant="outline"
							>
								Retry Worktree save
							</Button>
						}
						role="alert"
					>
						We couldn’t save Worktree settings. Retry the last change.
					</SettingsNotice>
				) : null}
				<GovernanceScopeSwitcher
					layers={snapshot?.layers ?? []}
					onValueChange={(nextView) => {
						setAutoDeleteLimitError(null);
						setView(nextView);
					}}
					value={view}
				/>
				<SettingsGroup>
					<WorktreeRow
						actions={
							<div className="flex items-center gap-2">
								<HugeiconsIcon
									className="size-4 text-muted-foreground"
									icon={Folder03Icon}
								/>
								<Input
									aria-label="Worktree root"
									className="w-64"
									defaultValue={String(effective("root"))}
									disabled={disabled || writeScope !== "node"}
									key={`${view}-${effective("root")}-${inputRevision}`}
									onBlur={(event) =>
										void update({ root: event.target.value.trim() })
									}
									placeholder="Default repository worktree folder"
								/>
							</div>
						}
						description="Choose Node to change this directory. Leave blank to use the repository's default worktree folder."
						title="Worktree root"
					/>
					<WorktreeRow
						actions={
							<Switch
								aria-label="Always fetch upstream before creating worktrees"
								checked={Boolean(effective("fetchUpstream"))}
								disabled={disabled || isLocked("fetchUpstream")}
								onCheckedChange={(checked) =>
									void update({ fetchUpstream: checked })
								}
							/>
						}
						description="Fetch branch updates before creating each new worktree"
						locked={isLocked("fetchUpstream")}
						title="Always fetch upstream before creating worktrees"
					/>
					<WorktreeRow
						actions={
							<Switch
								aria-label="Automatically delete old worktrees"
								checked={Boolean(effective("autoDelete"))}
								disabled={disabled || isLocked("autoDelete")}
								onCheckedChange={(checked) =>
									void update({ autoDelete: checked })
								}
							/>
						}
						description="Keep completed worktrees up to the limit, then snapshot older ones before pruning. Active worktrees are kept."
						locked={isLocked("autoDelete")}
						title="Automatically delete old worktrees"
					/>
					<WorktreeRow
						actions={
							<Input
								aria-describedby={
									autoDeleteLimitError ? "worktree-limit-error" : undefined
								}
								aria-invalid={Boolean(autoDeleteLimitError)}
								aria-label="Auto-delete limit"
								className="w-24"
								defaultValue={String(effective("autoDeleteLimit"))}
								disabled={
									disabled ||
									!effective("autoDelete") ||
									isLocked("autoDeleteLimit")
								}
								inputMode="numeric"
								key={`${view}-${effective("autoDeleteLimit")}-${inputRevision}`}
								max={100}
								min={1}
								onBlur={(event) => {
									const rawValue = event.target.value.trim();
									const value = Number(rawValue);
									if (
										/^\d+$/u.test(rawValue) &&
										Number.isInteger(value) &&
										value >= 1 &&
										value <= 100
									) {
										setAutoDeleteLimitError(null);
										update({ autoDeleteLimit: value });
									} else {
										setAutoDeleteLimitError(
											"Enter a whole number from 1 to 100."
										);
									}
								}}
								onChange={() => setAutoDeleteLimitError(null)}
								step={1}
								type="number"
							/>
						}
						description="Number of managed worktrees to keep before older ones are pruned"
						error={
							autoDeleteLimitError
								? {
										id: "worktree-limit-error",
										message: autoDeleteLimitError,
									}
								: undefined
						}
						locked={isLocked("autoDeleteLimit")}
						title="Auto-delete limit"
					/>
				</SettingsGroup>
			</SettingsSection>
			<SettingsSection
				caption="An isolate option on a worker message takes precedence."
				title="Coordinator workers"
			>
				{isolationQuery.isError ? (
					<SettingsNotice role="alert">
						Could not load the saved isolation default. Reopen settings to
						retry.
					</SettingsNotice>
				) : null}
				{isolationSaveError ? (
					<SettingsNotice role="alert">
						Could not save the isolation default. Try again.
					</SettingsNotice>
				) : null}
				<SettingsGroup>
					<WorktreeRow
						actions={
							<Switch
								aria-label="Use a worktree by default for coordinator workers"
								checked={isolationQuery.data ?? false}
								disabled={
									isolationSaving ||
									isolationQuery.isPending ||
									isolationQuery.isError
								}
								onCheckedChange={(checked) => {
									void updateIsolationDefault(checked);
								}}
							/>
						}
						description="Off by default. When enabled, worker turns use a dedicated Git worktree when their working directory is a Git repo."
						title="Use a worktree by default"
					/>
				</SettingsGroup>
			</SettingsSection>
			<SettingsSection
				caption={
					<CaptionInfo detail={"Open a project below to edit those details."}>
						{
							"Setup scripts, variables and actions stay with the project environment."
						}
					</CaptionInfo>
				}
				title="Environment handoff"
			>
				<SettingsCard className="flex items-center gap-2 text-muted-foreground text-sm">
					<HugeiconsIcon className="size-4 shrink-0" icon={Refresh01Icon} />
					Project environments run only when a new isolated worktree is created.
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
