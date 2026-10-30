import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type {
	GatewayDoctorFinding,
	GatewayDoctorReport,
} from "@/src/lib/api/gateway.ts";
import {
	GATEWAY_POSTURE_OPTIONS,
	type GatewayPosture,
} from "@/src/lib/api/gateway-posture.ts";
import { StatusText } from "../quiet.tsx";

export const levelIndex = (posture: GatewayPosture): number =>
	GATEWAY_POSTURE_OPTIONS.findIndex((option) => option.level === posture);

function severityTone(severity: GatewayDoctorFinding["severity"]): string {
	return severity === "error"
		? "text-status-destructive"
		: severity === "warning"
			? "text-status-warning"
			: "text-muted-foreground";
}

function DoctorFindingRow({ finding }: { finding: GatewayDoctorFinding }) {
	return (
		<div
			className="flex items-start gap-2 border-border border-b py-3 last:border-b-0"
			data-doctor-check-id={finding.checkId}
			data-doctor-severity={finding.severity}
		>
			<HugeiconsIcon
				aria-label={finding.severity}
				className={`mt-0.5 size-4 shrink-0 ${severityTone(finding.severity)}`}
				icon={finding.severity === "info" ? CheckmarkCircle02Icon : Alert02Icon}
			/>
			<div className="min-w-0 flex-1 space-y-1">
				<p className="text-sm">{finding.summary}</p>
				<p className="text-(length:--text-detail) text-pretty text-muted-foreground leading-(--text-detail--line-height)">
					{finding.detail}
					{finding.recommendedAction ? ` ${finding.recommendedAction}` : ""}
				</p>
				{finding.settingPath ? (
					<p className="font-mono text-muted-foreground text-xs">
						{finding.settingPath}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function DoctorSummary({
	report,
	compact,
}: {
	report: GatewayDoctorReport | null;
	compact: boolean;
}) {
	const tl = useLiteralMessages();
	const visibleFindings =
		report?.findings.slice(0, compact ? 2 : undefined) ?? [];
	if (!report) {
		return <SkeletonRows label="Running Doctor…" spacing="panel" />;
	}

	return (
		<div data-doctor-report="true">
			<div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 py-3">
				<StatusText
					className="text-foreground"
					tone={
						report.counts.errors > 0
							? "destructive"
							: report.counts.warnings > 0
								? "warning"
								: "success"
					}
				>
					{report.counts.errors > 0
						? tl(
								"{errors, plural, one {{errorsText} critical issue} other {{errorsText} critical issues}}",
								{
									errors: report.counts.errors,
									errorsText: formatCount(report.counts.errors) ?? "—",
								}
							)
						: report.counts.warnings > 0
							? tl(
									"{warnings, plural, one {{warningsText} warning} other {{warningsText} warnings}}",
									{
										warnings: report.counts.warnings,
										warningsText: formatCount(report.counts.warnings) ?? "—",
									}
								)
							: "Healthy"}
				</StatusText>
				{report.counts.info > 0 ? (
					<span className="text-muted-foreground text-xs">
						{tl(
							"{info, plural, one {{infoText} note} other {{infoText} notes}}",
							{
								info: report.counts.info,
								infoText: formatCount(report.counts.info) ?? "—",
							}
						)}
					</span>
				) : null}
				{visibleFindings.length > 0 ? null : (
					<span className="text-muted-foreground text-sm">
						No issues found.
					</span>
				)}
			</div>
			{visibleFindings.length > 0 ? (
				<div className="border-border border-t">
					{visibleFindings.map((finding) => (
						<DoctorFindingRow finding={finding} key={finding.checkId} />
					))}
				</div>
			) : null}
		</div>
	);
}
