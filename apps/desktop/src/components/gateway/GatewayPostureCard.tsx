import {
	Alert02Icon,
	CheckmarkCircle02Icon,
	Copy01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentAuditPanel } from "@ryu/marketplace/catalog/detail/agent-audit-panel";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { RangeSlider } from "@ryu/ui/components/motion/range-slider.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayDoctorFinding,
	GatewayDoctorFixResult,
	GatewayDoctorReport,
} from "@/src/lib/api/gateway.ts";
import { fetchGatewayDoctor, fixGatewayDoctor } from "@/src/lib/api/gateway.ts";
import {
	applyGatewayPosture,
	fetchGatewayCoverage,
	fetchGatewayPosture,
	GATEWAY_POSTURE_OPTIONS,
	type GatewayCoverageSnapshot,
	type GatewayPosture,
	type GatewayPostureSnapshot,
	setGatewayCoverage,
} from "@/src/lib/api/gateway-posture.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";

interface GatewayPostureCardProps {
	canConfigure?: boolean;
	compact?: boolean;
	onContinue?: () => void;
	onOpenAuditConversation?: (id: string) => void;
	reachable: boolean;
	target: ApiTarget;
}

const levelIndex = (posture: GatewayPosture): number =>
	GATEWAY_POSTURE_OPTIONS.findIndex((option) => option.level === posture);

function severityVariant(
	severity: GatewayDoctorFinding["severity"]
): "destructive" | "secondary" | "default" {
	return severity === "error"
		? "destructive"
		: severity === "warning"
			? "secondary"
			: "default";
}

function DoctorFindingRow({ finding }: { finding: GatewayDoctorFinding }) {
	return (
		<div
			className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
			data-doctor-check-id={finding.checkId}
		>
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={finding.severity === "info" ? CheckmarkCircle02Icon : Alert02Icon}
			/>
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={severityVariant(finding.severity)}>
						{finding.severity}
					</Badge>
					<span className="font-medium text-sm">{finding.summary}</span>
				</div>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{finding.detail}
				</p>
				{finding.settingPath ? (
					<p className="type-caption font-mono text-muted-foreground/80">
						{finding.settingPath}
					</p>
				) : null}
				{finding.recommendedAction ? (
					<p className="text-muted-foreground text-xs">
						{finding.recommendedAction}
					</p>
				) : null}
			</div>
		</div>
	);
}

function DoctorSummary({
	report,
	compact,
}: {
	report: GatewayDoctorReport | null;
	compact: boolean;
}) {
	const visibleFindings =
		report?.findings.slice(0, compact ? 2 : undefined) ?? [];
	if (!report) {
		return (
			<SettingsCard className="flex items-center gap-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Running Doctor…
			</SettingsCard>
		);
	}

	return (
		<div className="space-y-1.5" data-doctor-report="true">
			<SettingsCard className="flex flex-wrap items-center gap-2">
				<Badge
					variant={
						report.counts.errors > 0
							? "destructive"
							: report.counts.warnings > 0
								? "secondary"
								: "default"
					}
				>
					{report.counts.errors > 0
						? `${formatCount(report.counts.errors) ?? "—"} critical issue${report.counts.errors === 1 ? "" : "s"}`
						: report.counts.warnings > 0
							? `${formatCount(report.counts.warnings) ?? "—"} warning${report.counts.warnings === 1 ? "" : "s"}`
							: "Healthy"}
				</Badge>
				{report.counts.info > 0 ? (
					<span className="text-muted-foreground text-xs">
						{formatCount(report.counts.info) ?? "—"} note
						{report.counts.info === 1 ? "" : "s"}
					</span>
				) : null}
				{visibleFindings.length > 0 ? null : (
					<span className="text-muted-foreground text-xs">
						No configuration, security, or performance issues found.
					</span>
				)}
			</SettingsCard>
			{visibleFindings.length > 0 ? (
				<SettingsCard className="divide-y divide-border/60">
					{visibleFindings.map((finding) => (
						<DoctorFindingRow finding={finding} key={finding.checkId} />
					))}
				</SettingsCard>
			) : null}
		</div>
	);
}

export function GatewayPostureCard({
	target,
	canConfigure = true,
	reachable,
	compact = true,
	onContinue,
	onOpenAuditConversation,
}: GatewayPostureCardProps) {
	const tabsHost = useContext(TabsContext);
	const [snapshot, setSnapshot] = useState<GatewayPostureSnapshot | null>(null);
	const [coverage, setCoverage] = useState<GatewayCoverageSnapshot | null>(
		null
	);
	const [doctor, setDoctor] = useState<GatewayDoctorReport | null>(null);
	const [doctorFix, setDoctorFix] = useState<GatewayDoctorFixResult | null>(
		null
	);
	const [pending, setPending] = useState<GatewayPosture | null>(null);
	const [loading, setLoading] = useState(true);
	const [applying, setApplying] = useState(false);
	const [doctorFixing, setDoctorFixing] = useState(false);
	const [coverageSaving, setCoverageSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestTarget = useMemo(
		() => ({ url: target.url, token: target.token, userJwt: target.userJwt }),
		[target.url, target.token, target.userJwt]
	);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [nextSnapshot, nextCoverage, nextDoctor] = await Promise.all([
				fetchGatewayPosture(requestTarget),
				fetchGatewayCoverage(requestTarget),
				fetchGatewayDoctor(requestTarget),
			]);
			setSnapshot(nextSnapshot);
			setCoverage(nextCoverage);
			setDoctor(nextDoctor);
			setDoctorFix(null);
			setPending(null);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Doctor is unavailable"
			);
		} finally {
			setLoading(false);
		}
	}, [requestTarget]);

	useEffect(() => {
		if (reachable) {
			void refresh();
		}
	}, [reachable, refresh]);

	const activePosture = snapshot?.resolved;
	const shownPosture: GatewayPosture =
		pending ??
		(activePosture === "guarded" ||
		activePosture === "balanced" ||
		activePosture === "autonomous"
			? activePosture
			: "balanced");
	const shownOption = GATEWAY_POSTURE_OPTIONS[levelIndex(shownPosture)];
	const routeBoth = coverage?.claude === true && coverage.codex === true;

	const apply = async () => {
		if (!(pending && canConfigure)) {
			return;
		}
		setApplying(true);
		try {
			const next = await applyGatewayPosture(requestTarget, pending);
			setSnapshot(next);
			setPending(null);
			toast.success({
				title: `${GATEWAY_POSTURE_OPTIONS[levelIndex(pending)].label} posture applied`,
				description:
					pending === "autonomous"
						? "Approval prompts are off; Gateway scanning and redaction remain on."
						: "Gateway and Core are using the coordinated node-wide controls.",
			});
			await refresh();
		} catch (cause) {
			toast.error({
				title: "Could not apply posture",
				description: cause instanceof Error ? cause.message : "Try again.",
			});
		} finally {
			setApplying(false);
		}
	};

	const toggleCoverage = async (enabled: boolean) => {
		if (!canConfigure) {
			return;
		}
		setCoverageSaving(true);
		try {
			const next = await setGatewayCoverage(requestTarget, enabled);
			setCoverage(next);
			toast.success({
				title: enabled
					? "Claude and Codex will use Gateway routing"
					: "Claude and Codex routing is direct",
				description: "Restart the affected agent to apply the change.",
			});
			await refresh();
		} catch (cause) {
			toast.error({
				title: "Could not update Gateway coverage",
				description: cause instanceof Error ? cause.message : "Try again.",
			});
		} finally {
			setCoverageSaving(false);
		}
	};

	const copyDoctor = async () => {
		if (!doctor) {
			return;
		}
		try {
			await navigator.clipboard.writeText(JSON.stringify(doctor, null, 2));
			toast.success({ title: "Doctor report copied" });
		} catch {
			toast.error({ title: "Could not copy Doctor report" });
		}
	};

	const runDoctorFix = async (dryRun: boolean) => {
		if (!canConfigure) {
			return;
		}
		setDoctorFixing(true);
		try {
			const result = await fixGatewayDoctor(requestTarget, dryRun);
			setDoctor(result.report);
			setDoctorFix(result);
			if (dryRun) {
				toast.success({
					description:
						result.plannedFixes.length > 0
							? "Review the proposed setting changes before applying them."
							: "No safe automatic fixes are available.",
					title: "Doctor preview ready",
				});
			} else {
				toast.success({
					description:
						result.appliedFixes.length > 0
							? "The Gateway report has been refreshed after applying them."
							: "The Gateway was already using the safe baseline.",
					title:
						result.appliedFixes.length > 0
							? `${result.appliedFixes.length} safe fix${result.appliedFixes.length === 1 ? "" : "es"} applied`
							: "No changes needed",
				});
			}
		} catch (cause) {
			toast.error({
				description: cause instanceof Error ? cause.message : "Try again.",
				title: dryRun
					? "Could not preview Doctor fixes"
					: "Could not apply Doctor fixes",
			});
		} finally {
			setDoctorFixing(false);
		}
	};

	const caption = useMemo(() => {
		if (activePosture === "custom") {
			return "Individual settings differ from a preset. Choose a level to review and apply a coordinated baseline.";
		}
		if (activePosture === "pending") {
			return "Core and Gateway are not both reachable yet. The saved posture will apply when Gateway starts.";
		}
		return "One control coordinates Gateway guardrails with Core command approvals.";
	}, [activePosture]);
	const autoFixCount =
		doctor?.findings.filter((finding) => finding.canAutoFix).length ?? 0;

	return (
		<div className="space-y-4" data-gateway-posture="true">
			<SettingsSection caption={caption} title="Safety posture">
				{loading && !snapshot ? (
					<SettingsCard>
						<SkeletonRows label="Loading posture…" spacing="panel" />
					</SettingsCard>
				) : error && !snapshot ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									onClick={() => void refresh()}
									size="sm"
									variant="ghost"
								>
									Retry
								</Button>
							}
							title={<span className="text-muted-foreground">{error}</span>}
						/>
					</SettingsGroup>
				) : (
					<>
						<SettingsCard className="space-y-4">
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium text-sm">
										{shownOption.label}
									</span>
									{activePosture === "custom" ? (
										<Badge variant="secondary">Custom</Badge>
									) : null}
								</div>
								<p className="mt-1 text-muted-foreground text-xs">
									{shownOption.description}
								</p>
							</div>
							<div className={LEVEL_RAMP_CLASS}>
								<RangeSlider
									aria-label="Gateway safety posture"
									className="h-9"
									disabled={!canConfigure}
									fillColor={levelFillColor(
										levelIndex(shownPosture),
										GATEWAY_POSTURE_OPTIONS.length
									)}
									formatValueText={(value) =>
										GATEWAY_POSTURE_OPTIONS[Math.round(value)]
											?.accessibilityLabel ?? String(value)
									}
									max={GATEWAY_POSTURE_OPTIONS.length - 1}
									min={0}
									onValueChange={(value) => {
										const next =
											GATEWAY_POSTURE_OPTIONS[Math.round(value)]?.level;
										if (next) {
											setPending(next);
										}
									}}
									step={1}
									value={levelIndex(shownPosture)}
								/>
								<div className="type-caption flex items-center justify-between gap-2 pt-1 text-muted-foreground">
									{GATEWAY_POSTURE_OPTIONS.map((option) => (
										<span
											className={
												option.level === shownPosture
													? "font-medium text-foreground"
													: ""
											}
											key={option.level}
										>
											{option.label}
										</span>
									))}
								</div>
							</div>
							<p className="text-muted-foreground text-xs">
								{shownOption.risk}
							</p>
						</SettingsCard>
						{pending ? (
							<SettingsGroup>
								<SettingsItem
									actions={
										<div className="flex flex-wrap gap-2">
											<Button
												loading={applying}
												onClick={() => void apply()}
												size="sm"
											>
												Apply posture
											</Button>
											<Button
												disabled={applying}
												onClick={() => setPending(null)}
												size="sm"
												variant="ghost"
											>
												Cancel
											</Button>
										</div>
									}
									description="This updates Gateway firewall behavior and Core approval mode together."
									title={`Apply ${GATEWAY_POSTURE_OPTIONS[levelIndex(pending)].label}?`}
								/>
							</SettingsGroup>
						) : null}
					</>
				)}
			</SettingsSection>

			<SettingsSection
				caption="Supported subscription agents remain direct until you explicitly change this. Restart the affected agent after changing it."
				title="Gateway coverage"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={routeBoth}
								disabled={!canConfigure || coverageSaving || !coverage}
								onCheckedChange={(checked) => void toggleCoverage(checked)}
							/>
						}
						description={
							coverage?.genericAgentCount
								? `Claude and Codex are ${routeBoth ? "covered" : "not covered"}; ${coverage.genericAgentCount} other agent route${coverage.genericAgentCount === 1 ? " is" : "s are"} enabled.`
								: `Claude and Codex are ${routeBoth ? "covered" : "not covered"} by Gateway firewall, budget, and audit controls.`
						}
						title="Route Claude & Codex through Gateway"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Run checks for configuration, security, performance, connectivity, and agent coverage. Safe fixes are always previewed before they change settings."
				headerAction={
					<div className="flex flex-wrap items-center gap-1">
						<Button
							disabled={doctorFixing}
							loading={loading}
							onClick={() => void refresh()}
							size="sm"
							variant="ghost"
						>
							Run audit
						</Button>
						{canConfigure && autoFixCount > 0 && !doctorFix ? (
							<Button
								loading={doctorFixing}
								onClick={() => void runDoctorFix(true)}
								size="sm"
							>
								Preview safe fixes
							</Button>
						) : null}
						{doctor ? (
							<Button
								disabled={doctorFixing}
								onClick={() => void copyDoctor()}
								size="sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Copy01Icon} />
								Copy report
							</Button>
						) : null}
					</div>
				}
				title="Doctor"
			>
				<DoctorSummary compact={compact} report={doctor} />
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
					<SettingsCard className="space-y-3">
						<div>
							<p className="font-medium text-sm">Safe fixes ready to review</p>
							<p className="mt-1 text-muted-foreground text-xs">
								Dry run changed nothing. Apply only these protective Gateway
								settings?
							</p>
						</div>
						<div className="space-y-2">
							{doctorFix.plannedFixes.map((fix) => (
								<div className="text-xs" key={fix.checkId}>
									<span className="font-mono text-muted-foreground">
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
					<p className="px-3.5 text-status-success text-xs">
						Applied {doctorFix.appliedFixes.length} safe fix
						{doctorFix.appliedFixes.length === 1 ? "" : "es"}; the report above
						is current.
					</p>
				) : null}
			</SettingsSection>

			{onContinue ? (
				<div className="flex justify-end pt-2">
					<Button disabled={loading || applying} onClick={onContinue} size="lg">
						Continue
					</Button>
				</div>
			) : null}
		</div>
	);
}
