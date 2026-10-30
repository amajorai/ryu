import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

const appDisabledSchema = z.object({
	error: z.literal("app_disabled"),
	app: z.string(),
	message: z.string().nullish().catch(undefined),
});

/**
 * Thrown when Core refuses a first-party route because the App that owns it is
 * disabled (or not installed). Core answers `503 {"error":"app_disabled","app":
 * "<id>","message":"Enable the X app"}` (see `apps/core/src/server/mod.rs`
 * `app_disabled_response`); this is the typed, catchable client view. Surfaces
 * catch it to offer a one-click "Enable" instead of showing a dead error string.
 */
export class AppDisabledError extends Error {
	/** The owning App's manifest id the caller must enable (e.g. `@ryu/meetings`). */
	readonly app: string;
	constructor(app: string, message: string) {
		super(message);
		this.name = "AppDisabledError";
		this.app = app;
	}
}

/** Detect the `503 {error:"app_disabled", app, message}` contract in a response
 *  body and produce a typed {@link AppDisabledError}, or `null` when the body is
 *  not that shape. Kept in one place so every gated endpoint decodes it the same. */
export function appDisabledFromBody(
	status: number,
	text: string
): AppDisabledError | null {
	if (status !== 503 || !text) {
		return null;
	}
	try {
		const parsed = appDisabledSchema.safeParse(JSON.parse(text));
		if (parsed.success) {
			return new AppDisabledError(
				parsed.data.app,
				parsed.data.message ?? "This app is disabled."
			);
		}
	} catch {
		// Non-JSON 503 — not the app_disabled contract.
	}
	return null;
}

/**
 * A non-2xx response from a node. Carries the HTTP `status` and, when Core sent
 * one, a legacy string or structured error message as {@link serverMessage}, so a caller can tell
 * "this Core is too old to have the route" (404) apart from "Core refused"
 * (403) instead of guessing from a bare message string.
 *
 * `message` keeps the historical `"<path> failed: <status>"` shape — callers that
 * only log or match on the text are unaffected.
 */
export class ApiError extends Error {
	readonly body: AppResponseValue;
	readonly status: number;
	readonly serverMessage?: string;
	readonly code?: string;

	constructor(
		path: string,
		status: number,
		serverMessage?: string,
		code?: string,
		body?: Parameters<typeof appResponseValueSchema.parse>[0]
	) {
		super(`${path} failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.serverMessage = serverMessage;
		this.code = code;
		this.body = appResponseValueSchema.parse(body);
	}
}
