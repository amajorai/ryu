import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	fetchVaultAgentAccounts,
	parseLoginUrlLines,
	setVaultAgentAccountLoginUrls,
	type VaultAgentAccount,
} from "@/src/components/agents/AgentAccountAccessPanel-vault-accounts.ts";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { ApiError, type ApiTarget, toTarget } from "@/src/lib/api/client.ts";

function errorText(cause: unknown): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error
		? cause.message
		: "The login URLs were not saved.";
}

function AccountLoginUrls({
	account,
	agentId,
	disabled,
	onSaved,
	target,
}: {
	account: VaultAgentAccount;
	agentId: string;
	disabled: boolean;
	onSaved: () => void;
	target: ApiTarget;
}) {
	const saved = account.submitUrls.join("\n");
	const [text, setText] = useState(saved);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fieldId = `agent-account-login-urls-${account.id}`;

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const stored = await setVaultAgentAccountLoginUrls(
				target,
				agentId,
				account.id,
				parseLoginUrlLines(text)
			);
			setText(stored.join("\n"));
			onSaved();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<li className="flex flex-col gap-2">
			<Label htmlFor={fieldId}>
				<span className="truncate">{account.host || account.site}</span>
				{(account.username ?? account.email) ? (
					<span className="truncate text-muted-foreground text-xs">
						{account.username ?? account.email}
					</span>
				) : null}
			</Label>
			<Textarea
				disabled={disabled || saving}
				id={fieldId}
				onChange={(event) => setText(event.target.value)}
				placeholder={`https://${account.host}/login`}
				rows={2}
				spellCheck={false}
				value={text}
				variant="code-caption"
			/>
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button
					disabled={disabled || saving || text === saved}
					loading={saving}
					onClick={() => save()}
					size="sm"
					type="button"
					variant="outline"
				>
					Save login URLs
				</Button>
			</div>
		</li>
	);
}

/**
 * The login URLs of the agent's own website accounts. In a session Box a
 * fill submits an account's password only to one of them, so they decide
 * where the value can go. Hidden while the agent has no accounts.
 */
export function AgentAccountLoginUrlsPanel({
	agentId,
	disabled = false,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const queryClient = useQueryClient();
	const queryKey = ["vault-agent-accounts", target.url, agentId];
	const accounts = useQuery({
		queryFn: () => fetchVaultAgentAccounts(target, agentId),
		queryKey,
		staleTime: 15_000,
	});
	const rows = accounts.data ?? [];
	if (rows.length === 0) {
		return null;
	}
	return (
		<SettingsSection
			caption="In a session Box, the agent's password for an account is sent only to these addresses: one https URL per line, on the account's site."
			title="Account login URLs"
		>
			<SettingsCard>
				<ul className="flex flex-col gap-4">
					{rows.map((account) => (
						<AccountLoginUrls
							account={account}
							agentId={agentId}
							disabled={disabled}
							key={`${account.id}:${account.submitUrls.join(" ")}`}
							onSaved={() => queryClient.invalidateQueries({ queryKey })}
							target={target}
						/>
					))}
				</ul>
			</SettingsCard>
		</SettingsSection>
	);
}
