import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import type { PackageConnectionRequirement } from "@/src/lib/api/marketplace.ts";

// Connection-setup state for a private package install: the stages, per-row
// status, and the summary and label helpers.

export type InstallStage = "entry" | "preview" | "installing" | "complete";
export type SetupState =
	| "checking"
	| "connected"
	| "needs_connection"
	| "optional"
	| "unavailable"
	| "error";

export interface ConnectionStatus {
	message: string;
	state: SetupState;
}

export const ACTIVE_CONNECTION_STATES = new Set([
	"active",
	"connected",
	"ready",
]);

export function isComposioRequirement(
	requirement: PackageConnectionRequirement
): boolean {
	return (
		requirement.provider.toLowerCase() === "composio" ||
		Boolean(requirement.toolkit)
	);
}

export function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function setupSummary(
	requirements: PackageConnectionRequirement[],
	statuses: Map<string, ConnectionStatus>
) {
	const required = requirements.filter((requirement) => requirement.required);
	const connected = required.filter(
		(requirement) => statuses.get(requirement.id)?.state === "connected"
	).length;
	return {
		connected,
		missing: required.length - connected,
		required: required.length,
	};
}

export function statusLabel(state: SetupState): string {
	if (state === "connected") {
		return "Connected";
	}
	if (state === "optional") {
		return "Optional";
	}
	if (state === "checking") {
		return "Checking";
	}
	if (state === "unavailable") {
		return "Unavailable";
	}
	if (state === "error") {
		return "Could not check";
	}
	return "Needs connection";
}

export function statusIcon(state: SetupState) {
	return state === "connected" ? CheckmarkCircle02Icon : Alert02Icon;
}
