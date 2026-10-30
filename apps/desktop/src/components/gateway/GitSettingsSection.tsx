import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
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
import {
	ChoiceButtons,
	GitRow,
	GitTextArea,
	queryKey,
	visibleAtScope,
	writeScopeFor,
} from "./git-settings/fields.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

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
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Prompt guidance is treated as text and never executed as a command."
						}
					>
						{"Defaults for the Git actions Ryu can perform from a project."}
					</CaptionInfo>
				}
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
								label="Pull request merge method"
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
								label="Review delivery"
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
				caption={
					<CaptionInfo
						detail={
							"Ryu will not merge unrelated changes without the instructions you provide."
						}
					>
						{"Keeps pull-request automation explicit."}
					</CaptionInfo>
				}
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
						<p className="py-3 text-muted-foreground text-sm">
							Select User or Node to edit local instructions.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
		</div>
	);
}
