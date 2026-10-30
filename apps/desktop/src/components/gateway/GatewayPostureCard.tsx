import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
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
import { DoctorSection } from "./posture-card/doctor-section.tsx";
import { levelIndex } from "./posture-card/doctor-summary.tsx";
import { PostureLevelBody } from "./posture-card/posture-level-body.tsx";

/**
 * A failed write is one sentence in a toast. The raw cause (an HTTP status line
 * or a codec's validation JSON) is never shown; "Copy details" copies it.
 */
function reportFailure(title: string, cause: unknown) {
	const details = cause instanceof Error ? cause.message : String(cause);
	toast.error({
		title,
		description: "Check that Gateway is running, then try again.",
		button: {
			title: "Copy details",
			onClick: () => {
				navigator.clipboard.writeText(details).catch(() => undefined);
			},
		},
	});
}

interface GatewayPostureCardProps {
	canConfigure?: boolean;
	compact?: boolean;
	onContinue?: () => void;
	onOpenAuditConversation?: (id: string) => void;
	reachable: boolean;
	target: ApiTarget;
}

export function GatewayPostureCard({
	target,
	canConfigure = true,
	reachable,
	compact = true,
	onContinue,
	onOpenAuditConversation,
}: GatewayPostureCardProps) {
	const tl = useLiteralMessages();
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
			// The raw failure (often a codec's validation JSON) is kept for "Copy
			// details" and never rendered.
			setError(cause instanceof Error ? cause.message : String(cause));
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
				title: tl("{label} posture applied", {
					label: GATEWAY_POSTURE_OPTIONS[levelIndex(pending)].label,
				}),
				description:
					pending === "autonomous"
						? "Approval prompts are off; Gateway scanning and redaction remain on."
						: "Gateway and Core are using the coordinated node-wide controls.",
			});
			await refresh();
		} catch (cause) {
			reportFailure("Could not apply posture", cause);
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
			reportFailure("Could not update Gateway coverage", cause);
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
							? tl(
									"{count, plural, one {# safe fix applied} other {# safe fixes applied}}",
									{ count: result.appliedFixes.length }
								)
							: "No changes needed",
				});
			}
		} catch (cause) {
			reportFailure(
				dryRun
					? "Could not preview Doctor fixes"
					: "Could not apply Doctor fixes",
				cause
			);
		} finally {
			setDoctorFixing(false);
		}
	};

	const caption = useMemo(() => {
		if (activePosture === "custom") {
			return "Settings differ from a preset. Pick a level to apply a coordinated baseline.";
		}
		if (activePosture === "pending") {
			return "The saved posture applies once Gateway starts.";
		}
		return "One control for Gateway guardrails and Core command approvals.";
	}, [activePosture]);
	const autoFixCount =
		doctor?.findings.filter((finding) => finding.canAutoFix).length ?? 0;

	return (
		<div data-gateway-posture="true">
			<SettingsSection caption={caption} title="Safety posture">
				<PostureLevelBody
					activePosture={activePosture}
					apply={apply}
					applying={applying}
					canConfigure={canConfigure}
					error={error}
					loading={loading}
					pending={pending}
					refresh={refresh}
					setPending={setPending}
					shownOption={shownOption}
					shownPosture={shownPosture}
					snapshot={snapshot}
				/>
			</SettingsSection>

			<SettingsSection title="Gateway coverage">
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
								? tl(
										"{genericAgentCount, plural, one {# other agent route is} other {# other agent routes are}} enabled. Restart an agent to apply.",
										{ genericAgentCount: coverage.genericAgentCount }
									)
								: "Applies firewall, budget and audit controls. Restart an agent to apply."
						}
						title="Route Claude & Codex through Gateway"
					/>
				</SettingsGroup>
			</SettingsSection>

			<DoctorSection
				autoFixCount={autoFixCount}
				canConfigure={canConfigure}
				compact={compact}
				copyDoctor={copyDoctor}
				doctor={doctor}
				doctorFix={doctorFix}
				doctorFixing={doctorFixing}
				loading={loading}
				onOpenAuditConversation={onOpenAuditConversation}
				reachable={reachable}
				refresh={refresh}
				requestTarget={requestTarget}
				runDoctorFix={runDoctorFix}
				setDoctorFix={setDoctorFix}
				tabsHost={tabsHost}
				target={target}
			/>

			{onContinue ? (
				<div className="flex justify-end pt-2">
					<Button
						className="h-10 px-4"
						disabled={loading || applying}
						onClick={onContinue}
						variant="mono"
					>
						Continue
					</Button>
				</div>
			) : null}
		</div>
	);
}
