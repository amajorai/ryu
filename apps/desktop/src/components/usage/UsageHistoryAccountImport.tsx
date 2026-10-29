import {
	SettingsCard,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import type { HistoryAccountSyncRequest } from "@/src/lib/api/usage-history.ts";

const CONNECTORS = [
	{ id: "openai-org-usage", label: "OpenAI organization usage" },
	{ id: "openai-org-costs", label: "OpenAI organization costs" },
	{ id: "anthropic-org-usage", label: "Anthropic organization usage" },
	{ id: "anthropic-org-costs", label: "Anthropic organization costs" },
	{ id: "cursor-account", label: "Cursor team usage" },
];

export function UsageHistoryAccountImport({
	pending,
	onSync,
	nextCursor,
}: {
	pending: boolean;
	onSync: (request: HistoryAccountSyncRequest) => Promise<void>;
	nextCursor: string | null;
}) {
	const [sourceId, setSourceId] = useState("openai-org-usage");
	const [accountId, setAccountId] = useState("");
	const [credential, setCredential] = useState("");
	const [startDate, setStartDate] = useState(
		new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)
	);
	const [endDate, setEndDate] = useState(
		new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
	);
	const [resumeKey, setResumeKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const identity = JSON.stringify([sourceId, accountId, startDate, endDate]);
	const cursor = identity === resumeKey ? nextCursor : null;
	const sync = async () => {
		setError(null);
		if (
			!(accountId.trim() && credential.trim() && startDate && endDate) ||
			startDate >= endDate
		) {
			setError("Enter an account alias, admin key, and valid date range.");
			return;
		}
		const request: HistoryAccountSyncRequest = {
			sourceId,
			accountId: accountId.trim(),
			credential,
			startDate,
			endDate,
			...(cursor ? { cursor } : undefined),
		};
		setResumeKey(identity);
		try {
			await onSync(request);
		} finally {
			setCredential("");
		}
	};
	return (
		<SettingsSection
			caption="Import one page from the provider's official usage API. Organization admin access is required."
			title="Authorized provider reports"
		>
			<SettingsCard>
				<details>
					<summary className="cursor-pointer text-sm">
						Connect a usage report
					</summary>
					<div className="mt-4 grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5 text-xs">
							Provider report
							<select
								className="h-9 rounded-lg border border-input bg-background px-2 text-xs"
								disabled={pending}
								onChange={(event) => setSourceId(event.target.value)}
								value={sourceId}
							>
								{CONNECTORS.map((connector) => (
									<option key={connector.id} value={connector.id}>
										{connector.label}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1.5 text-xs">
							Account alias
							<Input
								disabled={pending}
								onChange={(event) => setAccountId(event.target.value)}
								placeholder="Stable alias for this account or organization"
								value={accountId}
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-xs">
							Start date UTC
							<Input
								disabled={pending}
								onChange={(event) => setStartDate(event.target.value)}
								type="date"
								value={startDate}
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-xs">
							End date UTC, exclusive
							<Input
								disabled={pending}
								onChange={(event) => setEndDate(event.target.value)}
								type="date"
								value={endDate}
							/>
						</label>
						<label className="flex flex-col gap-1.5 text-xs sm:col-span-2">
							{sourceId === "cursor-account"
								? "Cursor admin API key"
								: "Organization admin API key"}
							<Input
								autoComplete="off"
								disabled={pending}
								onChange={(event) => setCredential(event.target.value)}
								placeholder="Used for this request only"
								type="password"
								value={credential}
							/>
						</label>
					</div>
					<p className="mt-3 text-muted-foreground text-xs">
						The end date is exclusive. Tomorrow includes today's UTC usage. Keys
						are sent only to the selected Core node and the provider's fixed
						HTTPS API. Ryu does not save them. The key field clears after each
						attempt. Use a trusted node.
					</p>
					{error ? (
						<p className="mt-2 text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					{cursor ? (
						<p className="mt-2 text-muted-foreground text-xs">
							Another page is available. Re-enter the admin key to continue this
							report.
						</p>
					) : null}
					<Button
						className="mt-3"
						disabled={pending || !credential.trim() || !accountId.trim()}
						onClick={() => {
							void sync().catch(() =>
								setError("Unable to import this report.")
							);
						}}
						size="sm"
					>
						{pending
							? "Importing report…"
							: cursor
								? "Import next page"
								: "Import provider report"}
					</Button>
				</details>
			</SettingsCard>
		</SettingsSection>
	);
}
