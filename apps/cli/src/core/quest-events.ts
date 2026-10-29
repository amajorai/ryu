import { type ApiTarget, request } from "@ryuhq/core-client/client";
import {
	type QuestEventResponse,
	recordQuestEvent,
} from "@ryuhq/core-client/quest-events";
import { coreAuthStatusWireSchema } from "./auth-status-wire.ts";

import { accountBackendTarget } from "./authBackend.ts";

/**
 * Forward the active Core account's referral activity to the control plane.
 *
 * Core owns the local auth vault, so the CLI first asks Core for the Better Auth
 * bearer and then uses that distinct credential for the waitlist endpoint.
 * Missing auth or an offline Core is intentionally a no-op for CLI startup.
 */
export async function reportCliReferralEvent(
	coreTarget: ApiTarget
): Promise<QuestEventResponse | null> {
	try {
		const status = await request(
			coreTarget,
			"/api/auth/status",
			{},
			coreAuthStatusWireSchema
		);
		const token = status.authenticated ? status.token?.trim() : null;
		if (!token) {
			return null;
		}
		return await recordQuestEvent(
			accountBackendTarget(token),
			"referral_sync",
			"cli"
		);
	} catch {
		return null;
	}
}
