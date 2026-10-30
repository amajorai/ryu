"use client";

import { useRichLiteralMessages } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	historyProcessedTokens,
	type UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import { historyCounterDisplay } from "./history-format.ts";

export function RecordedAccounts({
	accounts,
}: {
	accounts: NonNullable<UsageHistoryReport["summary"]["accounts"]>;
}) {
	const tlRich = useRichLiteralMessages();
	return (
		// `data-slot="card"` scopes the recorded-accounts block (title and
		// rows) for the usage-history reconciliation proof.
		<div data-slot="card">
			<SettingsSection
				caption="Retained account IDs. Unknown identities are kept separate."
				title="Recorded accounts"
			>
				<SettingsGroup>
					{accounts.map((account) => {
						const counter = historyCounterDisplay(
							historyProcessedTokens(account.totals),
							[
								account.totals.missingInputRecords,
								account.totals.missingOutputRecords,
								account.totals.missingCacheReadRecords,
								account.totals.missingCacheWriteRecords,
							],
							account.records
						);
						return (
							<SettingsItem
								key={JSON.stringify([
									account.sourceId,
									account.accountId ?? null,
								])}
								title={
									<span className="break-all">
										{account.accountId ?? "Account not retained"}
									</span>
								}
							>
								<p className="break-all text-muted-foreground text-xs">
									{tlRich(
										"{sourceId} · {records} usage records · <value>{tokens}</value> tokens{partial, select, yes { · Partial} other {}}",
										{
											partial: counter.detail.includes("Partial")
												? "yes"
												: "no",
											records: formatNumber(account.records),
											sourceId: account.sourceId,
											tokens: counter.value,
										},
										{
											value: (chunks) => (
												<span title={counter.detail}>{chunks}</span>
											),
										}
									)}
								</p>
							</SettingsItem>
						);
					})}
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}

export function SourceCoverage({
	sources,
}: {
	sources: UsageHistoryReport["sources"];
}) {
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Cursor and other account histories need authorized provider data. Signing in alone may expose current quota without historical tokens. Ryu does not read browser cookies or infer missing history."
					}
				>
					{"Some histories need authorized provider data to import."}
				</CaptionInfo>
			}
			title="Source coverage and account access"
		>
			<SettingsGroup>
				{sources.map((source) => (
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm">
								{source.transport === "localFiles"
									? "Local history"
									: "Explicit export"}
							</span>
						}
						key={source.id}
						title={source.label}
					>
						<p className="text-muted-foreground text-xs">
							{source.limitations}
						</p>
					</SettingsItem>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}
