/**
 * The step-up ("confirm it's you") client, shared by every surface that can be
 * asked for a code: the website, the desktop app and the mobile app. The CLI
 * speaks the same three endpoints from Rust.
 *
 * Deliberately dependency-free and framework-free — no React, no env package, no
 * fetch wrapper. Each app differs only in where the API lives and how it proves
 * who it is (a cookie in the browser, a bearer token everywhere else), so those
 * are the two things it takes, and everything else is identical by construction
 * rather than by three copies staying in sync.
 *
 * The server half lives in packages/api/src/routers/step-up.ts; the scopes and
 * their meaning in packages/auth/src/lib/step-up.ts.
 */

/** Kept in step with STEP_UP_SCOPES in packages/auth/src/lib/step-up.ts. */
export type StepUpScope =
	| "account.merge"
	| "org.credentials"
	| "org.delete"
	| "org.features"
	| "org.members"
	| "node.destroy"
	| "billing"
	| "platform.admin";

/** How a code can be proven: authenticator app, emailed code, backup code. */
export type StepUpMethod = "totp" | "otp" | "backup";

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
	/** Email a fresh one-time code for `scope`. */
	challenge: (scope: StepUpScope) => Promise<void>;
	/** What this session would have to do to unlock `scope`. */
	status: (scope: StepUpScope) => Promise<StepUpStatus>;
	/** Prove a factor. Rejects with the server's reason when refused. */
	verify: (input: {
		code: string;
		method: StepUpMethod;
		scope: StepUpScope;
	}) => Promise<void>;
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
async function reasonFrom(res: Response): Promise<string> {
	const fallback = `Request failed (${res.status})`;
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
		const body = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
		const fromJson = body?.message ?? body?.error;
		if (typeof fromJson === "string" && fromJson.trim()) {
			return fromJson.trim();
		}
	} catch {
		// Plain text, handled below.
	}
	if (trimmed.startsWith("<") || trimmed.length > MAX_MESSAGE_LENGTH) {
		return fallback;
	}
	return trimmed;
}

export function createStepUpClient(options: StepUpClientOptions): StepUpClient {
	const doFetch = options.fetch ?? globalThis.fetch;
	const base = `${options.baseUrl.replace(/\/+$/, "")}/api/step-up`;

	async function request(path: string, init?: RequestInit): Promise<Response> {
		const extra = (await options.headers?.()) ?? {};
		return await doFetch(`${base}${path}`, {
			...init,
			credentials: options.includeCredentials ? "include" : undefined,
			headers: { ...extra, ...(init?.headers as Record<string, string>) },
		});
	}

	async function post(path: string, body: unknown): Promise<Response> {
		return await request(path, {
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
	}

	return {
		challenge: async (scope) => {
			const res = await post("/challenge", { scope });
			if (!res.ok) {
				throw new Error(await reasonFrom(res));
			}
		},
		status: async (scope) => {
			const res = await request(`/status?scope=${encodeURIComponent(scope)}`);
			if (!res.ok) {
				throw new Error(await reasonFrom(res));
			}
			return (await res.json()) as StepUpStatus;
		},
		verify: async (input) => {
			const res = await post("/verify", input);
			if (!res.ok) {
				throw new Error(await reasonFrom(res));
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
export function isStepUpRequired(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const error = (value as { error?: unknown }).error;
	if (typeof error === "string") {
		return error === STEP_UP_REQUIRED;
	}
	if (error && typeof error === "object") {
		return (error as { code?: unknown }).code === STEP_UP_REQUIRED;
	}
	return false;
}

/**
 * The prompt's single instruction line: what is about to happen and which code
 * answers for it. One sentence, not two — the same shape as the subtitle on the
 * device-activation page every surface already shows.
 */
const WHERE_THE_CODE_IS: Record<StepUpMethod, string> = {
	backup: "one of your backup codes",
	otp: "the code we emailed you",
	totp: "the code from your authenticator app",
};

export function stepUpPromptLine(input: {
	action: string;
	enrolmentRequired?: boolean;
	method: StepUpMethod;
}): string {
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
export const STEP_UP_CODE_LENGTH: Record<StepUpMethod, number> = {
	backup: 11,
	otp: 6,
	totp: 6,
};

/** True when this factor is free text rather than a fixed grid of slots. */
export function isFreeTextCode(method: StepUpMethod): boolean {
	return method === "backup";
}

/** Label for the button that switches to a given factor. */
export const STEP_UP_METHOD_LABEL: Record<StepUpMethod, string> = {
	backup: "Use a backup code",
	otp: "Email me a code",
	totp: "Use my authenticator app",
};
