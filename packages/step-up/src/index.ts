import { z } from "zod";
import { stepUpConfirmSentence } from "./copy.ts";

/**
 * The step-up ("confirm it's you") client, shared by every surface that can be
 * asked for a code: the website, the desktop app and the mobile app. The CLI
 * speaks the same three endpoints from Rust.
 *
 * Framework-free — no React, no env package, no
 * fetch wrapper. Each app differs only in where the API lives and how it proves
 * who it is (a cookie in the browser, a bearer token everywhere else), so those
 * are the two things it takes, and everything else is identical by construction
 * rather than by three copies staying in sync.
 *
 * The server half lives in packages/api/src/routers/step-up.ts; the scopes and
 * their meaning in packages/auth/src/lib/step-up.ts.
 */

export {
	STEP_UP_CONFIRM_COPY,
	STEP_UP_METHOD_LABEL,
	stepUpConfirmSentence,
} from "./copy.ts";
export { type EmailRetryWait, emailRetryWait } from "./retry-wait.ts";

/** Kept in step with STEP_UP_SCOPES in packages/auth/src/lib/step-up.ts. */
export type StepUpScope =
	| "account.merge"
	| "account.security"
	| "org.credentials"
	| "org.delete"
	| "org.features"
	| "org.members"
	| "org.security"
	| "node.destroy"
	| "billing"
	| "platform.admin"
	| "session.confirm";

/** How a step-up can be proven: a factor, password, or mailbox link. */
export type StepUpMethod =
	| "totp"
	| "otp"
	| "backup"
	| "password"
	| "magic-link";
export type StepUpChallengeMethod = Extract<StepUpMethod, "otp" | "magic-link">;

export interface StepUpStatus {
	/** Plain-language description of what the code authorizes. */
	action: string;
	/** True when this scope needs enrolled 2FA and the caller has none. */
	enrolmentRequired: boolean;
	/** Factors on offer, in the order they should be tried. */
	methods: StepUpMethod[];
	/** True when a live window already covers this scope. */
	satisfied: boolean;
	scope: StepUpScope;
	twoFactorEnabled: boolean;
	/** How long a fresh proof lasts, in milliseconds. */
	windowMs: number;
}

const stepUpScopeSchema = z.enum([
	"account.merge",
	"account.security",
	"org.credentials",
	"org.delete",
	"org.features",
	"org.members",
	"org.security",
	"node.destroy",
	"billing",
	"platform.admin",
	"session.confirm",
]);
const stepUpMethodSchema = z.enum([
	"totp",
	"otp",
	"backup",
	"password",
	"magic-link",
]);
const stepUpStatusSchema = z.object({
	action: z.string(),
	enrolmentRequired: z.boolean(),
	methods: z.array(stepUpMethodSchema),
	satisfied: z.boolean(),
	scope: stepUpScopeSchema,
	twoFactorEnabled: z.boolean(),
	windowMs: z.number(),
});
interface StepUpRequestBody {
	code?: string;
	method: StepUpMethod;
	scope: StepUpScope;
}
const stepUpErrorSchema = z.object({
	message: z.unknown().optional(),
	error: z.unknown().optional(),
	retryAfter: z.unknown().optional(),
});
/** A wait in seconds: a JSON number in the body, decimal digits in the header. */
const retryAfterSchema = z
	.union([
		z.number(),
		z
			.string()
			.trim()
			.regex(/^\d+(?:\.\d+)?$/u)
			.transform(Number),
	])
	.pipe(z.number().positive().finite());
const stepUpRequiredSchema = z.object({
	error: z.union([
		z.literal("STEP_UP_REQUIRED"),
		z.object({ code: z.literal("STEP_UP_REQUIRED") }),
	]),
});

/** The `error`/`code` value a gated endpoint returns when a step-up is missing. */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

/** Whether a step-up scope must keep its confirmation dialog open. */
export function isStepUpBlocking(scope: StepUpScope): boolean {
	return scope === "billing";
}

export interface StepUpClientOptions {
	/** API origin, no trailing slash — e.g. `https://api.ryuhq.com`. */
	baseUrl: string;
	/** Swap in a different fetch (tests, or a platform that lacks a global). */
	fetch?: typeof fetch;
	/**
	 * Per-request auth headers. A browser sends nothing here and relies on the
	 * session cookie (`credentials: "include"`); every other surface returns
	 * `{ Authorization: "Bearer …" }`. Async so a token can be read from a vault
	 * or refreshed at call time.
	 */
	headers?: () => Promise<Record<string, string>> | Record<string, string>;
	/**
	 * Send cookies. True in the browser, where the session IS a cookie; false
	 * elsewhere, where sending credentials cross-origin only invites trouble.
	 */
	includeCredentials?: boolean;
}

export interface StepUpClient {
	/** Email a fresh one-time code or verification link for `scope`. */
	challenge: (
		scope: StepUpScope,
		method?: StepUpChallengeMethod
	) => Promise<void>;
	/** What this session would have to do to unlock `scope`. */
	status: (scope: StepUpScope) => Promise<StepUpStatus>;
	/** Prove a factor. Rejects with the server's reason when refused. */
	verify: (input: {
		code: string;
		method: StepUpMethod;
		scope: StepUpScope;
	}) => Promise<void>;
	/** Consume a one-click mailbox proof from the settings verification page. */
	verifyMagicLink: (input: {
		scope: StepUpScope;
		token: string;
	}) => Promise<void>;
}

/**
 * A refused step-up request. `message` is the server's reason; `status` lets a
 * surface tell a wait (429, e.g. the one-minute email cooldown) from a
 * failure. `retryAfter` is that wait in whole seconds, from the body or the
 * `Retry-After` header, so a surface can say it in the user's language
 * (`emailRetryWait`) instead of showing the server's English sentence.
 */
export class StepUpRequestError extends Error {
	readonly retryAfter: number | undefined;
	readonly status: number;

	constructor(message: string, status: number, retryAfter?: number) {
		super(message);
		this.name = "StepUpRequestError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** Longest error body treated as a message rather than a stray page dump. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * The reason a request failed, in the user's language.
 *
 * Reads the body ONCE as text: a response body can only be consumed once, and
 * `res.json()` failing still drains it. Hono's `HTTPException` answers in plain
 * text, so both shapes have to work.
 */
async function reasonFrom(
	res: Response
): Promise<{ message: string; retryAfter?: unknown }> {
	const fallback = { message: `Request failed (${res.status})` };
	let text: string;
	try {
		text = await res.text();
	} catch {
		return fallback;
	}
	const trimmed = text.trim();
	if (!trimmed) {
		return fallback;
	}
	try {
		const body = stepUpErrorSchema.safeParse(JSON.parse(trimmed));
		if (body.success) {
			const fromJson = z
				.string()
				.safeParse(body.data.message ?? body.data.error);
			if (fromJson.success && fromJson.data.trim()) {
				return {
					message: fromJson.data.trim(),
					retryAfter: body.data.retryAfter,
				};
			}
		}
	} catch {
		// Plain text, handled below.
	}
	if (trimmed.startsWith("<") || trimmed.length > MAX_MESSAGE_LENGTH) {
		return fallback;
	}
	return { message: trimmed };
}

/** The wait a 429 names, in whole seconds: the body's, else `Retry-After`. */
function retryAfterFrom(res: Response, fromBody: unknown): number | undefined {
	if (res.status !== 429) {
		return undefined;
	}
	for (const candidate of [fromBody, res.headers.get("retry-after")]) {
		const seconds = retryAfterSchema.safeParse(candidate ?? undefined);
		if (seconds.success) {
			return Math.ceil(seconds.data);
		}
	}
	return undefined;
}

async function refusal(res: Response): Promise<StepUpRequestError> {
	const { message, retryAfter } = await reasonFrom(res);
	return new StepUpRequestError(
		message,
		res.status,
		retryAfterFrom(res, retryAfter)
	);
}

export function createStepUpClient(options: StepUpClientOptions): StepUpClient {
	// Resolve the global at call time: clients are created at module load, and
	// anything that wraps `fetch` afterwards (instrumentation, test fixtures)
	// must still see the requests.
	const doFetch = (...args: Parameters<typeof fetch>): Promise<Response> =>
		(options.fetch ?? globalThis.fetch)(...args);
	const base = `${options.baseUrl.replace(/\/+$/, "")}/api/step-up`;

	async function request(path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(await options.headers?.());
		new Headers(init?.headers).forEach((value, name) =>
			headers.set(name, value)
		);
		return await doFetch(`${base}${path}`, {
			...init,
			credentials: options.includeCredentials ? "include" : undefined,
			headers,
		});
	}

	async function post(
		path: string,
		body: StepUpRequestBody
	): Promise<Response> {
		return await request(path, {
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
	}

	return {
		challenge: async (scope, method = "otp") => {
			const res = await post("/challenge", { method, scope });
			if (!res.ok) {
				throw await refusal(res);
			}
		},
		status: async (scope) => {
			const res = await request(`/status?scope=${encodeURIComponent(scope)}`);
			if (!res.ok) {
				throw await refusal(res);
			}
			return stepUpStatusSchema.parse(await res.json());
		},
		verifyMagicLink: async ({ scope, token }) => {
			const res = await request(
				`/verify-link?scope=${encodeURIComponent(scope)}&token=${encodeURIComponent(token)}`
			);
			if (!res.ok) {
				throw await refusal(res);
			}
		},
		verify: async (input) => {
			const res = await post("/verify", input);
			if (!res.ok) {
				throw await refusal(res);
			}
		},
	};
}

/**
 * True when a Better Auth `{ error }` envelope is the server asking for a
 * step-up rather than refusing outright.
 *
 * The auth client RESOLVES with an error object instead of throwing, so a 403
 * from the gate would otherwise look like a successful call. Control-plane fetch
 * clients are a different story: they collapse a failure to its human message
 * and drop the code, so a lapsed window there is detected by re-reading
 * `status()` rather than by this predicate.
 */
export function isStepUpRequired(
	value: Parameters<typeof stepUpRequiredSchema.safeParse>[0]
): boolean {
	return stepUpRequiredSchema.safeParse(value).success;
}

/**
 * The prompt's single instruction line: what is about to happen and which code
 * answers for it. One sentence, not two: the same shape as the subtitle on the
 * device-activation page every surface already shows.
 *
 * A known `scope` reads its whole catalogued sentence from `copy.ts`, so every
 * surface can translate it by exact match. A scope this client does not know
 * (a newer server), or a caller with no scope, falls back to the server's
 * English `action` in the template below, which is also what each catalogued
 * sentence is byte-for-byte in English.
 */
const WHERE_THE_CODE_IS = {
	backup: "one of your backup codes",
	"magic-link": "the verification link we emailed you",
	otp: "the code we emailed you",
	password: "your current password",
	totp: "the code from your authenticator app",
} satisfies Record<StepUpMethod, string>;

export function stepUpPromptLine(input: {
	action: string;
	enrolmentRequired?: boolean;
	method: StepUpMethod;
	scope?: StepUpScope;
}): string {
	const catalogued = stepUpConfirmSentence(input);
	if (catalogued !== null) {
		return catalogued;
	}
	if (input.enrolmentRequired) {
		return `You're about to ${input.action}. This can't be undone.`;
	}
	return `Enter ${WHERE_THE_CODE_IS[input.method]} to ${input.action}.`;
}

/**
 * How many characters each factor's code has.
 *
 * A backup code is 11: Better Auth generates ten characters from `a-z 0-9 A-Z`
 * and prints them hyphenated as `xxxxx-xxxxx`. Both facts matter to the UI —
 * mixed case and a literal hyphen mean a backup code CANNOT go through a slot
 * grid that normalizes to upper-case alphanumerics, so surfaces render it as a
 * plain field. The sign-in 2FA page has always done this; the step-up prompt
 * matches it, because backup codes are the only way back into a staff account
 * whose authenticator is gone.
 */
export const STEP_UP_CODE_LENGTH = {
	backup: 11,
	"magic-link": 0,
	otp: 6,
	password: 128,
	totp: 6,
} satisfies Record<StepUpMethod, number>;

/** True when this factor is free text rather than a fixed grid of slots. */
export function isFreeTextCode(method: StepUpMethod): boolean {
	return method === "backup" || method === "password";
}
