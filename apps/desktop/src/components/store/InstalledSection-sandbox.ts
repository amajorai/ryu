// apps/desktop/src/components/store/InstalledSection-sandbox.ts
//
// OS sandbox status helpers for an installed app's sidecars.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { SidecarSandboxStatus } from "@/src/lib/api/plugins.ts";

const SANDBOX_BACKEND_LABELS = new Map<string, string>([
	["landlock", "Landlock"],
	["seatbelt", "Seatbelt"],
	["job_object", "Job Object"],
]);

/** How strongly a status confines its process, for picking the weakest. */
function sandboxStrength(status: SidecarSandboxStatus): number {
	if (status.fsRestricted) {
		return 2;
	}
	return status.enforced ? 1 : 0;
}

/** The least-confined OS isolation among an app's sidecars (keyed
 *  `<plugin_id>/<sidecar>`), so the detail never overstates the protection. */
export function appSandboxStatus(
	appId: string,
	statuses: Record<string, SidecarSandboxStatus>
): SidecarSandboxStatus | null {
	let weakest: SidecarSandboxStatus | null = null;
	for (const [name, status] of Object.entries(statuses)) {
		if (!name.startsWith(`${appId}/`)) {
			continue;
		}
		if (
			weakest === null ||
			sandboxStrength(status) < sandboxStrength(weakest)
		) {
			weakest = status;
		}
	}
	return weakest;
}

/** A short "OS sandbox" value for the app's Information card, as one
 *  translated message with the (brand) backend name as a value. */
export function sandboxLabel(
	status: SidecarSandboxStatus,
	tl: LiteralMessage
): string {
	const backend = SANDBOX_BACKEND_LABELS.get(status.backend) ?? status.backend;
	if (status.mode === "off") {
		return tl("Off");
	}
	if (status.mode === "audit") {
		return tl("Audit only");
	}
	if (status.fsRestricted) {
		return tl("Enforced · {backend}", { backend });
	}
	return status.enforced
		? tl("{backend} · no file limits", { backend })
		: tl("Unavailable");
}
