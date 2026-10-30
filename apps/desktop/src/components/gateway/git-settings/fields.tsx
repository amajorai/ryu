import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { ReactNode } from "react";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GitGovernanceSettings,
	GovernanceScope,
} from "@/src/lib/api/governance.ts";
import type { GovernanceView } from "../GovernanceScopeSwitcher.tsx";
import { Segmented } from "../quiet.tsx";

export const queryKey = (target: ApiTarget) => [
	"gateway-governance",
	target.url,
	target.token,
];

export const writeScopeFor = (
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

export const visibleAtScope = (view: GovernanceView, scope: GovernanceScope) =>
	view === "effective" || scopePriority[scope] <= scopePriority[view];

export function ChoiceButtons<Value extends string>({
	disabled,
	label,
	onChange,
	options,
	value,
}: {
	disabled: boolean;
	label: string;
	onChange: (value: Value) => void;
	options: ReadonlyArray<{ label: string; value: Value }>;
	value: Value;
}) {
	// A two-way choice reads best as a quiet segmented control: both options
	// stay visible and each keeps its button name and pressed state.
	return (
		<Segmented
			disabled={disabled}
			label={label}
			onChange={onChange}
			options={options}
			value={value}
		/>
	);
}

// A Git setting row. The description becomes the iOS footer caption under the
// row's card; the lock note and validation error stay inside the card, under the
// control they explain.
export function GitRow({
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

export function GitTextArea({
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
