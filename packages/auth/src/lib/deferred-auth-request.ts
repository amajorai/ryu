import { z } from "zod";
import { authApi } from "../auth-options/auth-instance.ts";
import { REPLAY_HEADER, REPLAY_MARKER } from "./deferred-replay-marker.ts";
import { runDetached } from "./detached-delivery.ts";
import type { PrepaidSend } from "./email-send-budget.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

// Requests that email an address and whose Better Auth endpoint does
// different work for a registered and an unknown address before it answers:
// it looks the address up, then writes a code or token and sends for one but
// not the other. Their answer never depends on the account, so Ryu answers it
// as soon as the request is valid and runs the endpoint itself afterwards,
// detached (lib/detached-delivery.ts). The request path then does the same
// work for every address. The replay carries a per-process marker so the
// cooldown hook lets it through without answering it again.

interface ReplayInput {
	body: unknown;
	headers: Headers;
}
interface ReplayableEndpoint {
	options: { body?: unknown };
	(input: ReplayInput): Promise<unknown>;
}
interface DeferredEndpoint {
	answer: Record<string, unknown>;
	endpoint: () => ReplayableEndpoint;
}
type DeferredApi = Record<
	| "forgetPasswordEmailOTP"
	| "requestPasswordReset"
	| "requestPasswordResetEmailOTP"
	| "sendVerificationEmail"
	| "sendVerificationOTP",
	ReplayableEndpoint
>;

// SAFETY: these five `auth.api` endpoints exist (Better Auth core and the
// email OTP plugin), and each replay sends the body that endpoint's own
// schema just accepted (`deferredAnswer`), so its body type holds.
const api = () => authApi() as unknown as DeferredApi;

const DEFERRED_ENDPOINTS: Readonly<Record<string, DeferredEndpoint>> = {
	"/email-otp/send-verification-otp": {
		answer: { success: true },
		endpoint: () => api().sendVerificationOTP,
	},
	"/email-otp/request-password-reset": {
		answer: { success: true },
		endpoint: () => api().requestPasswordResetEmailOTP,
	},
	"/forget-password/email-otp": {
		answer: { success: true },
		endpoint: () => api().forgetPasswordEmailOTP,
	},
	"/request-password-reset": {
		answer: {
			status: true,
			message:
				"If this email exists in our system, check your email for the reset link",
		},
		endpoint: () => api().requestPasswordReset,
	},
	"/send-verification-email": {
		answer: { status: true },
		endpoint: () => api().sendVerificationEmail,
	},
};

export const DEFERRED_AUTH_PATHS: ReadonlySet<string> = new Set(
	Object.keys(DEFERRED_ENDPOINTS)
);

interface BodySchema {
	safeParse: (value: unknown) => { success: boolean };
}

function isBodySchema(value: unknown): value is BodySchema {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}
const deferredBodySchema = z.object({
	email: z.string(),
	type: z.string().optional(),
});

type DeferHookContext = Parameters<typeof resolveSessionForHook>[0] & {
	body?: unknown;
	path?: string;
};

function requestHeader(ctx: DeferHookContext, name: string): string | null {
	return ctx.request?.headers.get(name) ?? ctx.headers?.get(name) ?? null;
}

/** Whether this request is Ryu's own detached replay of a deferred one. */
export function isDeferredReplay(ctx: DeferHookContext): boolean {
	return requestHeader(ctx, REPLAY_HEADER) === REPLAY_MARKER;
}

/**
 * Whether the endpoint would refuse this request whatever the address: a
 * body its schema rejects, an invalid address, or the change-email code (its
 * own endpoint). Each is refused before Better Auth looks anything up, so it
 * is left to the endpoint to answer. (Its form CSRF check has already run in
 * the cooldown hook, `assertFormCsrf`.)
 */
function refusedRegardlessOfAccount(
	deferred: DeferredEndpoint,
	ctx: DeferHookContext
): boolean {
	const schema = deferred.endpoint().options.body;
	if (isBodySchema(schema) && !schema.safeParse(ctx.body).success) {
		return true;
	}
	const body = deferredBodySchema.safeParse(ctx.body);
	if (
		!(
			body.success && z.email().safeParse(body.data.email.toLowerCase()).success
		)
	) {
		return true;
	}
	return body.data.type === "change-email";
}

/**
 * The answer for a deferrable request, with its endpoint queued to run
 * detached; null when the endpoint must answer it itself. Only HTTP requests
 * are deferred, and a signed-in verification resend is not (it mails the
 * caller's own address and refuses any other).
 */
export async function deferredAnswer(
	ctx: DeferHookContext,
	prepaid: PrepaidSend | null = null
): Promise<Record<string, unknown> | null> {
	const deferred = ctx.path ? DEFERRED_ENDPOINTS[ctx.path] : undefined;
	if (!(deferred && ctx.request) || refusedRegardlessOfAccount(deferred, ctx)) {
		return null;
	}
	if (
		ctx.path === "/send-verification-email" &&
		(await resolveSessionForHook(ctx))
	) {
		return null;
	}
	const headers = new Headers(ctx.request.headers);
	headers.set(REPLAY_HEADER, REPLAY_MARKER);
	const body = ctx.body;
	runDetached(
		"deferred auth request",
		() => deferred.endpoint()({ body, headers }),
		prepaid
	);
	return deferred.answer;
}
