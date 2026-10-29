import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import {
	fetchGatewayConfig,
	type GatewayConfig,
	type GatewayFirewallConfig,
	updateGatewayConfig,
} from "./gateway.ts";
import {
	getAgentGatewayRoutingMap,
	getClaudeGatewayRouting,
	getCodexGatewayRouting,
	getPreference,
	setClaudeGatewayRouting,
	setCodexGatewayRouting,
	setPreference,
} from "./preferences.ts";

export const GATEWAY_POSTURE_PREF_KEY = "gateway-posture";

export const GATEWAY_POSTURES = ["guarded", "balanced", "autonomous"] as const;

export type GatewayPosture = (typeof GATEWAY_POSTURES)[number];
export type ResolvedGatewayPosture = GatewayPosture | "custom" | "pending";
export type ApprovalMode = "manual" | "smart" | "off";

export interface GatewayPostureOption {
	accessibilityLabel: string;
	description: string;
	label: string;
	level: GatewayPosture;
	risk: string;
}

export const GATEWAY_POSTURE_OPTIONS: readonly GatewayPostureOption[] = [
	{
		level: "guarded",
		label: "Guarded",
		accessibilityLabel: "Guarded posture",
		description: "More approvals and stronger blocking for sensitive work.",
		risk: "Lowest autonomy · highest friction",
	},
	{
		level: "balanced",
		label: "Balanced",
		accessibilityLabel: "Balanced posture",
		description:
			"Keeps the shipped safety baseline while gating risky actions.",
		risk: "Recommended default",
	},
	{
		level: "autonomous",
		label: "Autonomous",
		accessibilityLabel: "Autonomous posture",
		description:
			"Fewer approval pauses, with more responsibility on the operator.",
		risk: "Highest autonomy · higher risk",
	},
];

export interface GatewayPostureSnapshot {
	approvalMode: ApprovalMode;
	config: GatewayConfig;
	execApprovalEnabled: boolean;
	resolved: ResolvedGatewayPosture;
	savedPosture: GatewayPosture | null;
}

export interface GatewayCoverageSnapshot {
	anyEnabled: boolean;
	claude: boolean;
	codex: boolean;
	genericAgentCount: number;
}

export function parseApprovalMode(raw: string | null): ApprovalMode {
	const value = raw?.trim().toLowerCase();
	if (value === "manual") {
		return "manual";
	}
	if (value === "off") {
		return "off";
	}
	return "smart";
}

export function parseExecApprovalEnabled(raw: string | null): boolean {
	return raw?.trim().toLowerCase() !== "off";
}

export function parseSavedPosture(raw: string | null): GatewayPosture | null {
	const parsed = z.enum(GATEWAY_POSTURES).safeParse(raw?.trim().toLowerCase());
	return parsed.success ? parsed.data : null;
}

function preservesSafetyInvariant(
	firewall: Partial<GatewayFirewallConfig>
): boolean {
	return (
		firewall.enabled === true &&
		firewall.scan_inbound === true &&
		firewall.scan_outbound === true &&
		firewall.redact_pii === true &&
		firewall.redact_secrets === true &&
		firewall.wrap_untrusted_tool_results !== false
	);
}

export function resolveGatewayPosture({
	approvalMode,
	execApprovalEnabled,
	firewall,
}: {
	approvalMode: ApprovalMode;
	execApprovalEnabled: boolean;
	firewall: Partial<GatewayFirewallConfig>;
}): ResolvedGatewayPosture {
	if (!(preservesSafetyInvariant(firewall) && execApprovalEnabled)) {
		return "custom";
	}
	if (firewall.policy === "block" && approvalMode === "manual") {
		return "guarded";
	}
	if (firewall.policy === "block" && approvalMode === "smart") {
		return "balanced";
	}
	if (firewall.policy === "sanitize" && approvalMode === "off") {
		return "autonomous";
	}
	return "custom";
}

export function firewallForPosture(
	current: Partial<GatewayFirewallConfig>,
	posture: GatewayPosture
): GatewayFirewallConfig {
	return {
		...current,
		enabled: true,
		scan_inbound: true,
		scan_outbound: true,
		log_detections: true,
		redact_pii: true,
		redact_secrets: true,
		wrap_untrusted_tool_results: true,
		policy: posture === "autonomous" ? "sanitize" : "block",
	};
}

export function approvalModeForPosture(posture: GatewayPosture): ApprovalMode {
	return posture === "guarded"
		? "manual"
		: posture === "autonomous"
			? "off"
			: "smart";
}

export async function fetchGatewayPosture(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayPostureSnapshot> {
	const [config, approvalRaw, execRaw, savedRaw] = await Promise.all([
		fetchGatewayConfig(target, signal),
		getPreference(target, "approval-mode"),
		getPreference(target, "exec-approval-mode"),
		getPreference(target, GATEWAY_POSTURE_PREF_KEY),
	]);
	const approvalMode = parseApprovalMode(approvalRaw);
	const execApprovalEnabled = parseExecApprovalEnabled(execRaw);
	return {
		config,
		approvalMode,
		execApprovalEnabled,
		savedPosture: parseSavedPosture(savedRaw),
		resolved: resolveGatewayPosture({
			approvalMode,
			execApprovalEnabled,
			firewall: config.firewall,
		}),
	};
}

export async function applyGatewayPosture(
	target: ApiTarget,
	posture: GatewayPosture
): Promise<GatewayPostureSnapshot> {
	// Arm Core's command scanner first. The saved posture is written last so a
	// partial update can never advertise a posture whose command gate is still
	// disabled.
	if (!(await setPreference(target, "exec-approval-mode", "enforce"))) {
		throw new Error(
			"Core could not arm command scanning. Run Doctor before continuing."
		);
	}
	const current = await fetchGatewayConfig(target);
	const firewall = firewallForPosture(current.firewall, posture);
	const result = await updateGatewayConfig(target, {
		firewall,
		expectedRevision: current.configRevision ?? undefined,
	});
	if (!result.ok) {
		throw new Error("Gateway rejected the posture change");
	}

	if (
		!(await setPreference(
			target,
			"approval-mode",
			approvalModeForPosture(posture)
		))
	) {
		throw new Error(
			"Gateway updated, but Core could not save the approval setting. Run Doctor before continuing."
		);
	}

	const verified = await fetchGatewayPosture(target);
	if (verified.resolved !== posture) {
		throw new Error(
			"Gateway and Core did not report the requested posture after command scanning was armed. Run Doctor before continuing."
		);
	}
	if (!(await setPreference(target, GATEWAY_POSTURE_PREF_KEY, posture))) {
		throw new Error(
			"Controls are active, but Core could not save the posture. Run Doctor before continuing."
		);
	}
	return fetchGatewayPosture(target);
}

export async function fetchGatewayCoverage(
	target: ApiTarget
): Promise<GatewayCoverageSnapshot> {
	const [claude, codex, generic] = await Promise.all([
		getClaudeGatewayRouting(target),
		getCodexGatewayRouting(target),
		getAgentGatewayRoutingMap(target),
	]);
	const genericAgentCount = Object.values(generic).filter(Boolean).length;
	return {
		claude,
		codex,
		genericAgentCount,
		anyEnabled: claude || codex || genericAgentCount > 0,
	};
}

export async function setGatewayCoverage(
	target: ApiTarget,
	enabled: boolean
): Promise<GatewayCoverageSnapshot> {
	const values = await Promise.all([
		setClaudeGatewayRouting(target, enabled),
		setCodexGatewayRouting(target, enabled),
	]);
	if (values.some((value) => !value)) {
		throw new Error("Could not update every supported agent route");
	}
	return fetchGatewayCoverage(target);
}
