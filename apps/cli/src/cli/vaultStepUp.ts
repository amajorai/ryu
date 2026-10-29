// `ryu secrets confirm` — the CLI's half of the `org.credentials` step-up.
//
// The control plane hands out shared (team and organization) plaintext through
// `reveal` and `export` only when one of two proofs comes with the request:
// this machine's org or team node vouches for it (Core sends the node key when
// the CLI talks to the node it runs next to with the owner token), or the
// session holds a fresh `org.credentials` step-up. The CLI holds no cloud
// session of its own: the local Core on this machine does (`ryu login`),
// whichever node the CLI targets. So the step-up is proved on that account
// session through the control plane's `/api/step-up/*` routes, reached with the
// same identity-broker bearer `get`, `export` and `run` mint their user JWT
// with. The grant is keyed by that session.
//
// Core forwards a shared read to the control plane with the user JWT minted
// from that session, and the control plane binds the JWT back to the session
// it names (`packages/api/src/lib/forwarded-user-jwt.ts`), so the grant this
// command proves is the one the read is checked against
// (`packages/api/src/lib/step-up-session-linkage.test.ts` pins this).

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { ApiError, type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";
import { coreAuthStatusWireSchema } from "../core/auth-status-wire.ts";
import { accountBackendTarget } from "../core/authBackend.ts";
import { identityBrokerFor } from "../core/identity.ts";
import { tf, tr } from "../i18n/translate.ts";
import { LocalizedError, localize } from "./localizedText.ts";
import { type CliContext, UsageError } from "./types.ts";

export const VAULT_STEP_UP_SCOPE = "org.credentials";

/** Factors the CLI can prove without a browser. */
const CLI_METHODS = ["totp", "backup", "password", "otp"] as const;
type CliMethod = (typeof CLI_METHODS)[number];
const cliMethodSchema = z.enum(CLI_METHODS);

/** Factors a code may be given for as an argument: each is single-use. A
 *  password is never taken as an argument (visible in `ps` and history). */
const ONE_TIME_METHODS = new Set<CliMethod>(["totp", "backup", "otp"]);

function nativeResponse<S extends z.ZodObject>(schema: S) {
	return z.custom<z.output<S>>(
		(input) =>
			appResponseValueSchema.safeParse(input).success &&
			schema.safeParse(input).success
	);
}

const stepUpStatusSchema = nativeResponse(
	z.looseObject({
		enrolmentRequired: z.boolean(),
		methods: z.array(z.string()),
		satisfied: z.boolean(),
		windowMs: z.number().optional(),
	})
);
const stepUpChallengeSchema = nativeResponse(
	z.looseObject({ sent: z.boolean() })
);
const stepUpVerifySchema = nativeResponse(
	z.looseObject({ verified: z.literal(true) })
);

/** True for Core's pass-through of the control plane's step-up refusal. */
export function isStepUpRequiredError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.status === 403 &&
		// The control plane's refusal code, passed through by Core unchanged.
		error.serverMessage === "STEP_UP_REQUIRED"
	);
}

/** The message `get`, `export` and `run` show instead of a bare 403. */
export const STEP_UP_HINT =
	"Shared team and organization values need a fresh identity confirmation for this request. Run `ryu secrets confirm`, then retry (it lasts 10 minutes).";

/**
 * Run a shared plaintext read, turning the step-up refusal into an actionable
 * error. Nothing is retried or dropped: `export` and `run` never continue with
 * only part of the values.
 */
export async function withStepUpHint<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (isStepUpRequiredError(error)) {
			throw new Error(STEP_UP_HINT);
		}
		throw error;
	}
}

/** Factors that also mark the session as signed in with two-factor, which an
 *  organization that requires two-factor checks when it mints the user JWT. */
const STRONG_FACTOR_METHODS = new Set<CliMethod>(["totp", "backup"]);

/**
 * Ask the local Core for a new user JWT. Organization claims are decided when
 * the token is minted, so an organization that requires two-factor appears in
 * it only after the confirmation; without this, the cached token would keep
 * leaving it out until it expires. Best effort: that expiry still applies.
 */
async function refreshBrokeredUserJwt(ctx: CliContext): Promise<void> {
	try {
		await request(
			localCore(ctx),
			"/api/auth/user-jwt?fresh=true",
			{},
			appResponseValueSchema
		);
	} catch {
		// The cached token expires on its own within minutes.
	}
}

/** Forwarding tunnels named in the refusal, as the docs name them. */
const TUNNELS =
	"Tailcat, a Cloudflare Quick Tunnel, OpenTunnel or a plugin tunnel";

/**
 * The local Core that holds this machine's account session. It is the CLI's
 * identity broker (the same one `get`, `export` and `run` mint their user JWT
 * from), so a remote, hosted or managed target changes nothing: the
 * confirmation is still proved on the account `ryu login` signed in here.
 */
function localCore(ctx: CliContext): ApiTarget {
	const broker: ApiTarget = { ...identityBrokerFor(ctx.target, ctx.env) };
	if (ctx.target.fetch) {
		broker.fetch = ctx.target.fetch;
	}
	return broker;
}

/** `/api/auth/status` from the local Core, with an actionable refusal. */
async function localSession(broker: ApiTarget) {
	try {
		return await request(
			broker,
			"/api/auth/status",
			{},
			coreAuthStatusWireSchema
		);
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.status === 401 || error.status === 403)
		) {
			throw new LocalizedError(
				localize(
					"The local Core at {url} refused this CLI. Set RYU_IDENTITY_CORE_TOKEN to its node token (secrets/node-auth.token in its data directory), then run `ryu secrets confirm` again.",
					{ url: broker.url }
				)
			);
		}
		// `fetch` rejects with a TypeError when nothing listens at the URL.
		if (!(error instanceof TypeError)) {
			throw error;
		}
		throw new LocalizedError(
			localize(
				"No Ryu Core answered at {url}. The confirmation is proved on the account you signed in to on this machine: start Ryu here and run `ryu login`, or set RYU_IDENTITY_CORE_URL to this machine's Core.",
				{ url: broker.url }
			)
		);
	}
}

/** The control-plane target for the session the local Core holds. */
async function sessionTarget(ctx: CliContext): Promise<ApiTarget> {
	const broker = localCore(ctx);
	const status = await localSession(broker);
	if (!status.authenticated) {
		throw new Error(
			"Sign in on this machine first (`ryu login`): the confirmation is proved on the account the local Core is signed in to."
		);
	}
	if (!status.token) {
		// Core withholds its session from every caller while a forwarding tunnel
		// is active: tunneled traffic arrives over loopback too.
		throw new LocalizedError(
			localize(
				"The local Core is signed in but does not hand out its session while a forwarding tunnel ({tunnels}) is active on it. Stop the tunnel, then run `ryu secrets confirm` again. While a tunnel runs, the local Core also withholds the identity token the CLI needs to read Team or Organization values.",
				{ tunnels: TUNNELS }
			)
		);
	}
	const target = accountBackendTarget(status.token, ctx.env);
	// An unconfigured loopback backend already carries a credential-stripping
	// transport; the injected one only replaces the default transport.
	if (ctx.target.fetch && !target.fetch) {
		target.fetch = ctx.target.fetch;
	}
	return target;
}

/** Factors a code typed as an argument is tried with, best guess first: an
 *  authenticator code is digits, a backup code is not. */
const NUMERIC_CODE_ORDER: readonly CliMethod[] = ["totp", "otp", "backup"];
const NUMERIC_CODE = /^\d+$/;
const OTHER_CODE_ORDER: readonly CliMethod[] = ["backup", "totp", "otp"];

function chooseMethod(
	offered: string[],
	requested: string | undefined,
	givenCode: string | undefined
) {
	const usable = offered.filter(
		(method): method is CliMethod => cliMethodSchema.safeParse(method).success
	);
	if (requested !== undefined) {
		const parsed = cliMethodSchema.safeParse(requested);
		if (!parsed.success) {
			throw new UsageError(
				localize("--method must be one of {methods}.", {
					methods: CLI_METHODS.join(", "),
				})
			);
		}
		if (!usable.includes(parsed.data)) {
			throw new UsageError(
				localize(
					"This account cannot confirm with {method}. Offered: {offered}.",
					{
						method: parsed.data,
						offered: usable.join(", ") || localize("none"),
					}
				)
			);
		}
		return parsed.data;
	}
	const code = givenCode?.trim();
	if (code) {
		const order = NUMERIC_CODE.test(code)
			? NUMERIC_CODE_ORDER
			: OTHER_CODE_ORDER;
		const guessed = order.find((method) => usable.includes(method));
		if (guessed) {
			return guessed;
		}
	}
	const first = usable[0];
	if (!first) {
		throw new Error(
			"None of this account's confirmation methods work from the terminal. Confirm in Ryu Desktop or the web console instead."
		);
	}
	return first;
}

/** What was piped on stdin, without the one line ending a pipe or a here
 *  string adds. A password keeps every other character as typed. */
const TRAILING_LINE_END = /\r?\n$/;
async function readPiped(ctx: CliContext): Promise<string | undefined> {
	return (await ctx.readStdin())?.replace(TRAILING_LINE_END, "");
}

/**
 * `ryu secrets confirm [CODE] [--method totp|backup|password|otp]`.
 *
 * Without a code, an emailed method sends the code and says how to finish.
 * A password is read from stdin only; one-time codes may also be an argument.
 */
export async function confirmIdentity(
	ctx: CliContext,
	args: { positional: string[]; values: Map<string, string[]> }
): Promise<number> {
	const target = await sessionTarget(ctx);
	const scope = VAULT_STEP_UP_SCOPE;
	const status = await request(
		target,
		`/api/step-up/status?scope=${scope}`,
		{},
		stepUpStatusSchema
	);
	if (status.satisfied) {
		ctx.io.err(
			`${tr("Already confirmed: the confirmation is still within its window.")}\n`
		);
		return 0;
	}
	if (status.enrolmentRequired) {
		throw new Error(
			"Turn on two-factor authentication for this account before confirming."
		);
	}
	const given = args.positional[1];
	const method = chooseMethod(
		status.methods,
		args.values.get("--method")?.at(-1),
		given
	);
	if (given !== undefined && !ONE_TIME_METHODS.has(method)) {
		throw new UsageError(
			"Pipe the password on stdin; it is never accepted as an argument."
		);
	}
	let code: string | undefined = given?.trim();
	if (!code) {
		const piped = await readPiped(ctx);
		code = method === "password" ? piped : piped?.trim();
	}
	if (!code) {
		if (method === "otp") {
			await request(
				target,
				"/api/step-up/challenge",
				{ method: "POST", body: { scope, method } },
				stepUpChallengeSchema
			);
			ctx.io.err(
				`${tr("We emailed you a code. Finish with: ryu secrets confirm CODE --method otp")}\n`
			);
			return 0;
		}
		throw new UsageError(
			method === "password"
				? localize(
						"Pipe your password on stdin: ryu secrets confirm --method password"
					)
				: localize(
						"Give the code: ryu secrets confirm CODE --method {method}",
						{
							method,
						}
					)
		);
	}
	await request(
		target,
		"/api/step-up/verify",
		{ method: "POST", body: { scope, method, code } },
		stepUpVerifySchema
	);
	if (STRONG_FACTOR_METHODS.has(method)) {
		await refreshBrokeredUserJwt(ctx);
	}
	const minutes = Math.round((status.windowMs ?? 10 * 60_000) / 60_000);
	ctx.io.err(
		`${tf(
			"Confirmed for the next {minutes, plural, one {# minute} other {# minutes}} on the account signed in on this machine.",
			{ minutes }
		)}\n`
	);
	return 0;
}
