"use client";

import { Switch } from "@ryu/ui/components/switch.tsx";
import { useState } from "react";
import { CaptionInfo, Segmented } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	useHistoryTargetRevision,
	useUsageHistory,
} from "@/src/hooks/useUsageHistory.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { HistoryScope } from "@/src/lib/api/usage-history.ts";
import { UsageHistoryAccountImport } from "./UsageHistoryAccountImport.tsx";
import { SCOPES } from "./UsageHistoryDashboard-shared.tsx";
import { UsageHistoryView } from "./UsageHistoryDashboard-view.tsx";

export type { UsageHistoryViewProps } from "./UsageHistoryDashboard-view.tsx";
export { UsageHistoryView } from "./UsageHistoryDashboard-view.tsx";

export function UsageHistoryDashboard({ target }: { target: ApiTarget }) {
	const [days, setDays] = useState<number | null>(null);
	const [scope, setScope] = useState<HistoryScope>("session");
	const history = useUsageHistory(target, days, scope);
	const revision = useHistoryTargetRevision(target);
	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					scope === "unattributed" ? (
						<CaptionInfo
							detail={
								"This usage lacks reliable native session, model, or usage-date attribution and may overlap other reports. Totals stay separate. Snapshot dates show when metadata was observed. Conversation counts include only retained Ryu conversation IDs."
							}
						>
							{"May overlap other reports, so its totals stay separate."}
						</CaptionInfo>
					) : scope === "unreconciled" ? (
						<CaptionInfo
							detail={
								"These live turns retain their native session identity. Imported native history exists for the same session, but shared turn IDs were not retained to prove overlap. All unmatched live counters, including newer turns, stay here. Do not add this subtotal to Session history."
							}
						>
							{
								"Live turns that can't be matched to imported history. Don't add to Session history."
							}
						</CaptionInfo>
					) : undefined
				}
				title="Usage history"
			>
				<Segmented
					label="History report scope"
					onChange={setScope}
					options={SCOPES}
					value={scope}
				/>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Track future ACP usage"
								checked={history.trackingEnabled}
								disabled={
									!history.trackingAvailable || history.trackingUpdating
								}
								onCheckedChange={(enabled) => {
									void history.toggleTracking(enabled);
								}}
							/>
						}
						description="Session history, account reports, and organization reports can overlap. Each view has its own totals. Future ACP tracking stores only reported model and token metadata. Live turns with unresolved native-history overlap stay in Unreconciled live usage and are excluded from Session history totals."
						title="Track future ACP usage"
					/>
				</SettingsGroup>
				{history.trackingError ? (
					<p className="px-3 text-destructive text-xs" role="alert">
						{history.trackingError}
					</p>
				) : null}
			</SettingsSection>
			<UsageHistoryView
				key={`${revision}:${scope}`}
				{...history}
				days={days}
				onDaysChange={setDays}
				onImport={history.runImport}
				onRefresh={history.refresh}
				scope={scope}
			/>
			<UsageHistoryAccountImport
				key={revision}
				nextCursor={history.nextCursor}
				onSync={history.syncAccount}
				pending={history.importing}
			/>
		</div>
	);
}
