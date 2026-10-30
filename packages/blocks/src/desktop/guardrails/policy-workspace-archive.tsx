"use client";

import { Button } from "@ryu/ui/components/button";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import type { PolicyView } from "./policy-model.ts";
import { StatusLine } from "./policy-workspace-chrome.tsx";
import { policyErrorMessage } from "./policy-workspace-errors.ts";
import type {
	PolicyWorkspaceClient,
	PolicyWorkspaceProps,
} from "./policy-workspace-types.ts";

export function ArchivePanel({
	canEdit,
	client,
	onArchived,
	policy,
	runWrite,
}: {
	canEdit: boolean;
	client: PolicyWorkspaceClient;
	onArchived: () => void;
	policy: PolicyView;
	runWrite: PolicyWorkspaceProps["runWrite"];
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const assigned = policy.assignments.length > 0;

	if (!canEdit) {
		return null;
	}

	const archive = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await runWrite(() => client.archive(policy.id));
			if (result !== null) {
				onArchived();
			}
		} catch (archiveError) {
			setError(
				policyErrorMessage(archiveError, "Could not archive the policy.")
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsSection
			caption={
				assigned
					? "Remove every assignment before archiving. Archived policies keep their version history."
					: "Archived policies leave this list and keep their version history."
			}
			title="Archive"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Button
							disabled={assigned || busy}
							loading={busy}
							onClick={() => {
								archive().catch(() => undefined);
							}}
							size="sm"
							variant="destructive"
						>
							Archive policy
						</Button>
					}
					title="Archive this policy"
				/>
			</SettingsGroup>
			<StatusLine error={error} success={null} />
		</SettingsSection>
	);
}
