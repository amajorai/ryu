import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";
import type { AccountProbeResult } from "../core/account-polling.ts";
import {
	type Account,
	accountsResponseSchema,
	sessionsResponseSchema,
} from "../core/account-response.ts";
import {
	type CoreAuthStatusWire as CoreAuthStatus,
	coreAuthStatusWireSchema,
} from "../core/auth-status-wire.ts";
import { accountBackendTarget } from "../core/authBackend.ts";
import { nativeErrorMessage as errText } from "../core/native-errors.ts";
import { tf } from "../i18n/translate.ts";
import {
	type SecuritySessionResponse as SessionWire,
	securityPasswordStatusResponseSchema,
	securitySessionResponseSchema,
} from "../overlays/settings/account-security-response-contracts.ts";

// Data layer for the Account tab: Core device-flow probes plus the
// control-plane profile/billing/session fetches.

export interface AuthInfo {
	authMethod: string;
	email: string;
	hasPassword: boolean;
	name: string;
	plan: string;
	sessionCount: number;
	token: string;
	twoFactor: boolean;
	verified: boolean;
}

export interface LoginPrompt {
	url: string | null;
	userCode: string | null;
}

// One signed-in account in the local device vault Core maintains. Tokens NEVER
// cross the wire - Core returns only these safe fields (parity with the shared
// multi-account contract used by every bearer surface).

// Mirror apps/cli main.rs::format_plan: collapse the subscription payload into a
// short human label.
function formatPlan(sub: SubscriptionStatus): string {
	const lifetime = sub.lifetime;
	if (lifetime) {
		const lt = lifetime;
		if (lt.expired === true) {
			return "Lifetime (updates expired)";
		}
		const until = lt.updatesExpiresAt?.split("T")[0] ?? "—";
		return `Lifetime (updates until ${until})`;
	}

	const subscription = sub.subscription;
	if (subscription) {
		const s = subscription;
		const status = s.status;
		const interval = s.interval;
		if (status === "trialing") {
			return `Trial (${interval}ly after trial)`;
		}
		let label = interval;
		if (interval === "month") {
			label = "monthly";
		} else if (interval === "year") {
			label = "annual";
		}
		return `Pro (${label})`;
	}

	return "Free";
}

export type LoadResult =
	| { kind: "coreDown"; message: string }
	| { kind: "loggedIn"; info: AuthInfo }
	| { kind: "loggedOut" };

// One device-status probe of the flow `/api/auth/login` started under
// `userCode`. Core stays `authenticated` with the previous account when an "add
// account" flow is denied or expires, so success is read from the outcome Core
// records for THIS code (`lastFlow`), never from `authenticated` alone.
export async function pollOnce(
	target: ApiTarget,
	userCode: string | null,
	signal?: AbortSignal
): Promise<AccountProbeResult> {
	const status = await request(
		target,
		"/api/auth/status",
		{
			signal,
		},
		coreAuthStatusWireSchema
	);
	const flow = status.lastFlow;
	if (userCode !== null && flow?.userCode === userCode) {
		return flow.result === "succeeded"
			? true
			: { failed: flow.error ?? "failed" };
	}
	if (status.pending) {
		return false;
	}
	if (userCode === null || flow === undefined) {
		// A Core that predates `lastFlow` (or a flow without a code) only
		// publishes the settled state.
		return Boolean(status.authenticated && status.token);
	}
	// Core is no longer waiting and recorded no outcome for this code: the flow
	// was cancelled (sign-out) or replaced by another one.
	return { failed: "cancelled" };
}

// Human copy for a device flow that ended without signing in.
export function describeFlowFailure(reason: string): string {
	if (reason === "access_denied") {
		return "Sign-in was denied";
	}
	if (reason === "device_code_expired" || reason === "timeout") {
		return "Sign-in code expired";
	}
	if (reason === "cancelled") {
		return "Sign-in was cancelled";
	}
	return tf("Sign-in failed: {reason}", { reason });
}

// Resolve the full account state in one pass (no setState - the caller applies it
// once, guarded by mountedRef). get-session gates logged-in (parity with
// auth.rs::fetch_auth_info); password/billing/sessions degrade independently.
export async function fetchAuth(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<LoadResult> {
	let status: CoreAuthStatus;
	try {
		status = await request(
			target,
			"/api/auth/status",
			{
				signal,
			},
			coreAuthStatusWireSchema
		);
	} catch (err) {
		return { kind: "coreDown", message: errText(err) };
	}
	const token = status.token ?? null;
	if (!token) {
		return { kind: "loggedOut" };
	}

	const authTarget = accountBackendTarget(token);
	let session: SessionWire;
	try {
		session = await request(
			authTarget,
			"/api/auth/get-session",
			{
				signal,
			},
			securitySessionResponseSchema
		);
	} catch {
		return { kind: "loggedOut" };
	}
	const user = session?.user;
	if (!user) {
		return { kind: "loggedOut" };
	}

	const [pw, sub, sessions] = await Promise.all([
		request(
			authTarget,
			"/api/user/password-status",
			{
				signal,
			},
			securityPasswordStatusResponseSchema
		).catch(() => null),
		request(
			authTarget,
			"/api/billing/subscription-status",
			{ signal },
			appResponseValueSchema
		)
			.then((value) => subscriptionStatusSchema.parse(value))
			.catch(() => null),
		request(
			authTarget,
			"/api/sessions",
			{ signal },
			sessionsResponseSchema
		).catch(() => null),
	]);

	return {
		kind: "loggedIn",
		info: {
			token,
			name: user.name ?? "Unknown",
			email: user.email ?? "—",
			verified: user.emailVerified ?? false,
			twoFactor: user.twoFactorEnabled ?? false,
			hasPassword: pw?.hasPassword ?? false,
			authMethod: pw?.authMethod ?? "unknown",
			plan: sub ? formatPlan(sub) : "—",
			sessionCount: sessions?.sessions?.length ?? 0,
		},
	};
}

// List the signed-in accounts from Core's local vault. Degrades to an empty
// list so a vault/read failure never blocks the profile view.
export async function fetchAccounts(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Account[]> {
	try {
		const wire = await request(
			target,
			"/api/auth/accounts",
			{
				signal,
			},
			accountsResponseSchema
		);
		return Array.isArray(wire.accounts) ? wire.accounts : [];
	} catch {
		return [];
	}
}

const subscriptionStatusSchema = z.object({
	lifetime: z
		.object({
			expired: z.boolean().catch(false),
			updatesExpiresAt: z.string().nullable().catch(null),
		})
		.nullable()
		.catch(null),
	subscription: z
		.object({
			status: z.string().catch("unknown"),
			interval: z.string().catch(""),
		})
		.nullable()
		.catch(null),
});
type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
