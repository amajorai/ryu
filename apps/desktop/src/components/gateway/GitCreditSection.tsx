import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getGitCreditRyu,
	RYU_COAUTHOR_TRAILER,
	setGitCreditRyu,
} from "@/src/lib/api/git-credit-preference.ts";
import { SettingsNotice } from "./SettingsNotice.tsx";

const creditQueryKey = (target: ApiTarget) => [
	"git-credit-ryu",
	target.url,
	target.token,
];

/**
 * The node's "Credit Ryu in git commits" switch. It is a plain Core
 * preference, not a governance layer, so it sits in its own section below the
 * scoped Git rows. A node that never saved the preference reads as on.
 */
export function GitCreditSection({ target }: { target: ApiTarget }) {
	const queryClient = useQueryClient();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState(false);
	const query = useQuery({
		queryKey: creditQueryKey(target),
		queryFn: () => getGitCreditRyu(target),
	});

	const updateCredit = async (enabled: boolean) => {
		setSaveError(false);
		setSaving(true);
		try {
			await setGitCreditRyu(target, enabled);
			queryClient.setQueryData(creditQueryKey(target), enabled);
		} catch {
			setSaveError(true);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="Commits an agent makes on its own are credited on a best-effort basis."
			title="Commit credit"
		>
			{query.isError ? (
				<SettingsNotice role="alert">
					Could not load the saved commit credit setting. Reopen settings to
					retry.
				</SettingsNotice>
			) : null}
			{saveError ? (
				<SettingsNotice role="alert">
					Could not save the commit credit setting. Try again.
				</SettingsNotice>
			) : null}
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Credit Ryu in git commits"
							checked={query.data ?? true}
							disabled={saving || query.isPending || query.isError}
							onCheckedChange={(checked) => {
								void updateCredit(checked);
							}}
						/>
					}
					description="Adds Ryu as a co-author on commits Ryu makes for you."
					title="Credit Ryu in git commits"
				>
					<p className="text-muted-foreground text-xs">
						<code translate="no">{RYU_COAUTHOR_TRAILER}</code>
					</p>
				</SettingsItem>
			</SettingsGroup>
		</SettingsSection>
	);
}
