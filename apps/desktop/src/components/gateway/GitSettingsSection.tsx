import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
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
	type GitGovernanceSettings,
	type GovernanceScope,
	isGovernanceFieldLocked,
	updateGatewayGovernance,
} from "@/src/lib/api/governance.ts";
import {
	DEFAULT_GIT_SETTINGS,
	resolveGitSetting,
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

function ChoiceButtons<Value extends string>({
	disabled,
	onChange,
	options,
	value,
}: {
	disabled: boolean;
	onChange: (value: Value) => void;
	options: ReadonlyArray<{ label: string; value: Value }>;
	value: Value;
}) {
	return (
		<div className="flex items-center gap-1 rounded-full bg-muted p-1">
			{options.map((option) => (
				<button
					aria-pressed={value === option.value}
					className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
						value === option.value
							? "bg-background font-medium text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground"
					}`}
					disabled={disabled}
					key={option.value}
					onClick={() => onChange(option.value)}
					type="button"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

// A Git setting row. The description becomes the iOS footer caption under the
// row's card; the lock note and validation error stay inside the card, under the
// control they explain.
function GitRow({
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

function GitTextArea({
	disabled,
	onCommit,
	onPullRequest,
	onWatch,
	settings,
}: {
	disabled: boolean;
	onCommit: (value: string) => void;
	onPullRequest: (value: string) => void;
	onWatch: (value: string) => void;
	settings: GitGovernanceSettings;
}) {
	// Tall text areas are `bare` rows: the textarea's own border is the only
	// edge, so it never reads as a box inside a card.
	return (
		<SettingsGroup>
			<SettingsItem
				bare
				description="Guidance added when Ryu watches a pull request."
				title={
					<label htmlFor="git-watch-instructions">
						Watch and fix pull requests
					</label>
				}
			>
				<Textarea
					defaultValue={settings.watchInstructions ?? ""}
					disabled={disabled}
					id="git-watch-instructions"
					onBlur={(event) => onWatch(event.target.value)}
					placeholder="For example: Comment /merge after checks pass and approve unrelated changes…"
				/>
			</SettingsItem>
			<SettingsItem
				bare
				description="Guidance added to commit message generation prompts."
				title={
					<label htmlFor="git-commit-instructions">Commit instructions</label>
				}
			>
				<Textarea
					defaultValue={settings.commitInstructions ?? ""}
					disabled={disabled}
					id="git-commit-instructions"
					onBlur={(event) => onCommit(event.target.value)}
					placeholder="Add commit message guidance…"
				/>
			</SettingsItem>
			<SettingsItem
				bare
				description="Guidance added to pull request title and description prompts."
				title={
					<label htmlFor="git-pr-instructions">Pull request instructions</label>
				}
			>
				<Textarea
					defaultValue={settings.pullRequestInstructions ?? ""}
					disabled={disabled}
					id="git-pr-instructions"
					onBlur={(event) => onPullRequest(event.target.value)}
					placeholder="Add pull request guidance…"
				/>
			</SettingsItem>
		</SettingsGroup>
	);
}

export function GitSettingsSection({
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
	const [branchPrefixError, setBranchPrefixError] = useState<string | null>(
		null
	);
	const [pendingSave, setPendingSave] = useState<{
		scope: Extract<GovernanceScope, "node" | "user">;
		values: GitGovernanceSettings;
	} | null>(null);
	const query = useQuery({
		queryKey: queryKey(target),
		queryFn: ({ signal }) => fetchGatewayGovernance(target, signal),
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
	const localSettings = selectedLayer?.values.git ?? {};
	const effective = <Key extends keyof GitGovernanceSettings>(key: Key) =>
		resolveGitSetting(displayedSnapshot, key)?.value ??
		DEFAULT_GIT_SETTINGS[key];
	const disabled =
		!snapshot ||
		query.isPending ||
		query.isError ||
		!writeScope ||
		(writeScope === "node" && !canConfigure) ||
		saving;
	// An organization/team lock makes a field read-only for the user layer; the
	// node layer sits below the organization and is never the override path.
	const isLocked = (key: keyof GitGovernanceSettings) =>
		writeScope === "user" && isGovernanceFieldLocked(snapshot, `git.${key}`);

	const save = async (
		scope: Extract<GovernanceScope, "node" | "user">,
		values: GitGovernanceSettings
	) => {
		setSaveError(false);
		setPendingSave(null);
		setSaving(true);
		try {
			const next = await updateGatewayGovernance(target, "git", scope, values);
			queryClient.setQueryData(queryKey(target), next);
		} catch {
			setPendingSave({ scope, values });
			setSaveError(true);
		} finally {
			setSaving(false);
		}
	};

	const update = (patch: GitGovernanceSettings) => {
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

	const validateBranchPrefix = (value: string): string | null => {
		if (new TextEncoder().encode(value).byteLength > 80) {
			return "Branch prefixes must be at most 80 bytes.";
		}
		if (/\s/u.test(value) || value.includes("..")) {
			return "Branch prefixes cannot contain whitespace or '..'.";
		}
		return null;
	};

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Defaults for the Git actions Ryu can perform from a project. Prompt guidance is treated as text and never executed as a command."
				title="Git"
			>
				{query.isPending ? (
					<SettingsNotice role="status">Loading Git settings…</SettingsNotice>
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
						We couldn’t load Git settings. Try again before editing them.
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
								Retry Git save
							</Button>
						}
						role="alert"
					>
						We couldn’t save Git settings. Retry the last change.
					</SettingsNotice>
				) : null}
				<GovernanceScopeSwitcher
					layers={snapshot?.layers ?? []}
					onValueChange={(nextView) => {
						setBranchPrefixError(null);
						setView(nextView);
					}}
					value={view}
				/>
				<SettingsGroup>
					<GitRow
						actions={
							<Input
								aria-describedby={
									branchPrefixError ? "git-branch-prefix-error" : undefined
								}
								aria-invalid={Boolean(branchPrefixError)}
								aria-label="Branch prefix"
								className="w-36"
								defaultValue={String(effective("branchPrefix"))}
								disabled={disabled || isLocked("branchPrefix")}
								key={`${view}-${effective("branchPrefix")}`}
								onBlur={(event) => {
									const branchPrefix = event.target.value.trim();
									const error = validateBranchPrefix(branchPrefix);
									setBranchPrefixError(error);
									if (!error) {
										update({ branchPrefix });
									}
								}}
								onChange={() => setBranchPrefixError(null)}
							/>
						}
						description="Prefix used when Ryu creates new branches"
						error={
							branchPrefixError
								? {
										id: "git-branch-prefix-error",
										message: branchPrefixError,
									}
								: undefined
						}
						locked={isLocked("branchPrefix")}
						title="Branch prefix"
					/>
					<GitRow
						actions={
							<ChoiceButtons
								disabled={disabled || isLocked("mergeMethod")}
								onChange={(mergeMethod) => update({ mergeMethod })}
								options={[
									{ label: "Merge", value: "merge" },
									{ label: "Squash", value: "squash" },
								]}
								value={
									effective("mergeMethod") === "squash" ? "squash" : "merge"
								}
							/>
						}
						description="Choose how Ryu merges pull requests"
						locked={isLocked("mergeMethod")}
						title="Pull request merge method"
					/>
					<GitRow
						actions={
							<Switch
								aria-label="Always force push"
								checked={Boolean(effective("alwaysForcePush"))}
								disabled={disabled || isLocked("alwaysForcePush")}
								onCheckedChange={(checked) =>
									update({ alwaysForcePush: checked })
								}
							/>
						}
						description="Use force-with-lease when pushing from Ryu"
						locked={isLocked("alwaysForcePush")}
						title="Always force push"
					/>
					<GitRow
						actions={
							<Switch
								aria-label="Create draft pull requests"
								checked={Boolean(effective("createDraftPullRequests"))}
								disabled={disabled || isLocked("createDraftPullRequests")}
								onCheckedChange={(checked) =>
									update({ createDraftPullRequests: checked })
								}
							/>
						}
						description="Use draft pull requests by default when creating PRs"
						locked={isLocked("createDraftPullRequests")}
						title="Create draft pull requests"
					/>
					<GitRow
						actions={
							<ChoiceButtons
								disabled={disabled || isLocked("reviewDelivery")}
								onChange={(reviewDelivery) => update({ reviewDelivery })}
								options={[
									{ label: "Inline", value: "inline" },
									{ label: "Detached", value: "detached" },
								]}
								value={
									effective("reviewDelivery") === "detached"
										? "detached"
										: "inline"
								}
							/>
						}
						description="Start review in the current chat or a separate review chat"
						locked={isLocked("reviewDelivery")}
						title="Review delivery"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="These controls keep pull-request automation explicit. Ryu will not merge unrelated changes without the instructions you provide."
				title="Watch and fix pull requests"
			>
				<SettingsGroup>
					<GitRow
						actions={
							<Switch
								aria-label="Auto-merge when ready"
								checked={Boolean(effective("autoMergeWhenReady"))}
								disabled={disabled || isLocked("autoMergeWhenReady")}
								onCheckedChange={(checked) =>
									update({ autoMergeWhenReady: checked })
								}
							/>
						}
						description="Continue watching until the pull request is merged"
						locked={isLocked("autoMergeWhenReady")}
						title="Auto-merge when ready"
					/>
					<GitRow
						actions={
							<Switch
								aria-label="Auto-address pull request comments"
								checked={Boolean(effective("autoAddressPullRequestComments"))}
								disabled={
									disabled || isLocked("autoAddressPullRequestComments")
								}
								onCheckedChange={(checked) =>
									update({ autoAddressPullRequestComments: checked })
								}
							/>
						}
						description="When collaborators leave new comments or reviews on a linked pull request, ask its chat to address them"
						locked={isLocked("autoAddressPullRequestComments")}
						title="Auto-address pull request comments"
					/>
					<GitRow
						actions={
							<Switch
								aria-label="Archive chat when pull requests close"
								checked={Boolean(
									effective("autoArchiveClosedPullRequestChats")
								)}
								disabled={
									disabled || isLocked("autoArchiveClosedPullRequestChats")
								}
								onCheckedChange={(checked) =>
									update({ autoArchiveClosedPullRequestChats: checked })
								}
							/>
						}
						description="Archive a chat once every pull request linked to it is merged or closed"
						locked={isLocked("autoArchiveClosedPullRequestChats")}
						title="Archive chat when pull requests close"
					/>
				</SettingsGroup>
				{writeScope ? (
					<GitTextArea
						disabled={
							disabled ||
							isLocked("watchInstructions") ||
							isLocked("commitInstructions") ||
							isLocked("pullRequestInstructions")
						}
						key={writeScope}
						onCommit={(commitInstructions) => update({ commitInstructions })}
						onPullRequest={(pullRequestInstructions) =>
							update({ pullRequestInstructions })
						}
						onWatch={(watchInstructions) => update({ watchInstructions })}
						settings={localSettings}
					/>
				) : (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							Select User or Node to edit local instructions.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
		</div>
	);
}
