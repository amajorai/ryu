import { useLiteralMessages } from "@ryu/i18n/react";
import { AgentAuditPanel } from "@ryu/marketplace/catalog/detail/agent-audit-panel";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ContextType, Dispatch, SetStateAction } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayDoctorFixResult,
	GatewayDoctorReport,
} from "@/src/lib/api/gateway.ts";
import { OverflowMenu } from "../quiet.tsx";
import { DoctorSummary } from "./doctor-summary.tsx";

/** The Doctor audit: run it, preview and apply safe fixes, copy the report. */
export function DoctorSection({
	autoFixCount,
	canConfigure,
	compact,
	copyDoctor,
	doctor,
	doctorFix,
	doctorFixing,
	loading,
	onOpenAuditConversation,
	reachable,
	refresh,
	requestTarget,
	runDoctorFix,
	setDoctorFix,
	tabsHost,
	target,
}: {
	autoFixCount: number;
	canConfigure: boolean;
	compact: boolean;
	copyDoctor: () => Promise<void>;
	doctor: GatewayDoctorReport | null;
	doctorFix: GatewayDoctorFixResult | null;
	doctorFixing: boolean;
	loading: boolean;
	onOpenAuditConversation: ((id: string) => void) | undefined;
	reachable: boolean;
	refresh: () => Promise<void>;
	requestTarget: ApiTarget;
	runDoctorFix: (dryRun: boolean) => Promise<void>;
	setDoctorFix: Dispatch<SetStateAction<GatewayDoctorFixResult | null>>;
	tabsHost: ContextType<typeof TabsContext>;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Checks configuration, security, performance and agent coverage. Fixes are previewed first."
			headerAction={
				<div className="flex items-center gap-1">
					<Button
						disabled={doctorFixing}
						loading={loading}
						onClick={() => void refresh()}
						size="sm"
						variant="outline"
					>
						Run audit
					</Button>
					<OverflowMenu
						items={[
							...(canConfigure && autoFixCount > 0 && !doctorFix
								? [
										{
											id: "preview-fixes",
											label: "Preview safe fixes",
											disabled: doctorFixing,
											onSelect: () => void runDoctorFix(true),
										},
									]
								: []),
							...(doctor
								? [
										{
											id: "copy-report",
											label: "Copy report",
											disabled: doctorFixing,
											onSelect: () => void copyDoctor(),
										},
									]
								: []),
						]}
						label="More Doctor actions"
					/>
				</div>
			}
			title="Doctor"
		>
			{doctor || loading ? (
				<DoctorSummary compact={compact} report={doctor} />
			) : (
				// The audit could not run (Core or Gateway unreachable): say so once
				// instead of a skeleton that never resolves.
				<p className="py-3 text-muted-foreground text-sm">
					No report yet. Run audit once Gateway is reachable.
				</p>
			)}
			{doctor && reachable && !loading ? (
				<div>
					<AgentAuditPanel
						key={JSON.stringify([target.url, doctor])}
						onOpenConversation={
							onOpenAuditConversation ??
							(tabsHost
								? (conversationId) =>
										tabsHost.openTab("/chat", { conversationId })
								: undefined)
						}
						runAudit={() =>
							runCatalogScan(requestTarget, {
								kind: "gateway",
								id: "gateway",
								name: "Gateway health doctor",
								metadata: { doctor },
								scorecard: null,
							})
						}
					/>
				</div>
			) : null}
			{doctorFix?.dryRun && doctorFix.plannedFixes.length > 0 ? (
				<SettingsCard className="space-y-3 border-border border-t pt-3">
					<div>
						<p className="font-medium text-sm">Safe fixes ready to review</p>
						<p className="text-(length:--text-detail) mt-1 text-muted-foreground leading-(--text-detail--line-height)">
							Nothing has changed yet. Apply these protective settings?
						</p>
					</div>
					<div className="space-y-2">
						{doctorFix.plannedFixes.map((fix) => (
							<div className="text-sm" key={fix.checkId}>
								<span className="font-mono text-muted-foreground text-xs">
									{fix.settingPath}
								</span>
								<span className="ml-2">{fix.action}</span>
							</div>
						))}
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							loading={doctorFixing}
							onClick={() => void runDoctorFix(false)}
							size="sm"
							variant="mono"
						>
							Apply safe fixes
						</Button>
						<Button
							disabled={doctorFixing}
							onClick={() => setDoctorFix(null)}
							size="sm"
							variant="ghost"
						>
							Dismiss
						</Button>
					</div>
				</SettingsCard>
			) : null}
			{doctorFix && !doctorFix.dryRun && doctorFix.appliedFixes.length > 0 ? (
				<p className="text-muted-foreground text-xs">
					{tl(
						"Applied {count, plural, one {# safe fix} other {# safe fixes}}; the report above is current.",
						{ count: doctorFix.appliedFixes.length }
					)}
				</p>
			) : null}
		</SettingsSection>
	);
}
