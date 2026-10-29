import { z } from "zod";
import {
	type AppRequestValue,
	type AppResponseValue,
	appRequestValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { ApiError, type ApiTarget, request } from "./client.ts";

export const mountedAppPathInputSchema = z.string();
/** Retry classifiers inspect raw native failures; each host decodes its own
 * ApiError class. The raw input is never claimed to be a validated Error. */
export const mountedAppFailureInputSchema = z.instanceof(Error);
export type MountedAppPathInput = Parameters<
	typeof mountedAppPathInputSchema.parse
>[0];
export type MountedAppFailureInput = Parameters<
	typeof mountedAppFailureInputSchema.parse
>[0];
const nativeApiErrorSchema = z.instanceof(ApiError);

export type AppRequestMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/** Raw JSON serialization input is decoded before it reaches the transport. */
export type AppRequestBodyInput = Parameters<
	typeof appRequestValueSchema.parse
>[0];
export interface AppRequestInput {
	body?: AppRequestBodyInput;
	method?: AppRequestMethod;
	path: string;
	signal?: AbortSignal;
}

export interface MountedAppRequestPolicy {
	allowedMethods: ReadonlySet<AppRequestMethod>;
	invalidMethodMessage: (method: AppRequestMethod) => string;
	invalidPathMessage: (path: MountedAppPathInput) => string;
	mount: string;
}

export interface ValidatedMountedAppRequest {
	body?: AppRequestValue;
	method: AppRequestMethod;
	path: string;
	signal?: AbortSignal;
}

/** Keep platform-specific HTTP errors, credentials and instrumentation at the caller. */
export interface MountedAppTransport {
	isRetryableReadError(error: MountedAppFailureInput): boolean;
	request(
		target: ApiTarget,
		input: ValidatedMountedAppRequest
	): Promise<AppResponseValue>;
}

const defaultTransport: MountedAppTransport = {
	request: (target, input) =>
		request(
			target,
			input.path,
			{
				body: input.body,
				method: input.method,
				signal: input.signal,
			},
			appResponseValueSchema
		).then(appResponseValueSchema.parse),
	isRetryableReadError: (error) => {
		const parsed = nativeApiErrorSchema.safeParse(error);
		return (
			parsed.success &&
			(parsed.data.status === 502 || parsed.data.status === 503)
		);
	},
};

const METHODS: ReadonlySet<AppRequestMethod> = new Set([
	"DELETE",
	"GET",
	"PATCH",
	"POST",
	"PUT",
]);
const PARSE_BASE = "http://app.invalid";
const MOUNTED_APP_READ_RETRY_DELAYS_MS = [100, 300] as const;

/**
 * Resolve an untrusted sub-path beneath one fixed app mount.
 *
 * This is the shared companion host's canonical containment check. The sandbox RPC layer
 * deliberately performs its own independent validation before a request reaches
 * this function; centralizing the host-side copy keeps every mounted app on the
 * same WHATWG URL semantics without weakening that two-layer boundary.
 */
export function resolveMountedAppPath(
	mount: string,
	path: MountedAppPathInput
): string | null {
	const parsed = mountedAppPathInputSchema.safeParse(path);
	if (
		!(parsed.success && mount?.startsWith("/")) ||
		mount.startsWith("//") ||
		mount.includes("\\") ||
		!parsed.data.startsWith("/") ||
		parsed.data.startsWith("//") ||
		parsed.data.includes("\\")
	) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(`${mount}${parsed.data}`, PARSE_BASE);
	} catch {
		return null;
	}
	if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) {
		return null;
	}
	return `${url.pathname}${url.search}`;
}

/** Validate the path and method once before issuing either JSON or custom I/O. */
export function validateMountedAppRequest(
	input: AppRequestInput,
	policy: MountedAppRequestPolicy
): ValidatedMountedAppRequest {
	const path = resolveMountedAppPath(policy.mount, input.path);
	if (!path) {
		throw new Error(policy.invalidPathMessage(input.path));
	}
	const method = input.method ?? "GET";
	if (!policy.allowedMethods.has(method)) {
		throw new Error(policy.invalidMethodMessage(method));
	}
	return {
		body: appRequestValueSchema.parse(input.body),
		method,
		path,
		signal: input.signal,
	};
}

/** RN's AbortSignal may expose neither reason nor throwIfAborted. */
function appRequestAbortError(): Error {
	const error = new Error("The app request was aborted");
	error.name = "AbortError";
	return error;
}

/** Check cancellation without requiring DOM-only AbortSignal methods. */
export function throwIfAppRequestAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal?.reason === undefined ? appRequestAbortError() : signal.reason;
	}
}

/** Keep startup retry delays owned by the calling read. */
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				signal?.reason === undefined ? appRequestAbortError() : signal.reason
			);
			return;
		}
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(
				signal?.reason === undefined ? appRequestAbortError() : signal.reason
			);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** Forward a request that already passed the mounted-app path and method policy. */
export async function requestValidatedMountedApp(
	target: ApiTarget,
	validated: ValidatedMountedAppRequest,
	transport: MountedAppTransport = defaultTransport
): Promise<AppResponseValue> {
	for (let attempt = 0; ; attempt++) {
		throwIfAppRequestAborted(validated.signal);
		try {
			return appResponseValueSchema.parse(
				await transport.request(target, validated)
			);
		} catch (error) {
			const retryableRead =
				validated.method === "GET" && transport.isRetryableReadError(error);
			const delay = MOUNTED_APP_READ_RETRY_DELAYS_MS[attempt];
			if (!retryableRead || delay === undefined) {
				throw error;
			}
			await waitForRetry(delay, validated.signal);
		}
	}
}

/** Validate and forward one JSON request beneath a fixed mounted app path. */
export async function mountedAppRequest(
	target: ApiTarget,
	input: AppRequestInput,
	policy: MountedAppRequestPolicy,
	transport: MountedAppTransport = defaultTransport
): Promise<AppResponseValue> {
	const validated = validateMountedAppRequest(input, policy);
	return await requestValidatedMountedApp(target, validated, transport);
}

export function resolveOwnAppPath(
	pluginId: string,
	path: MountedAppPathInput
): string | null {
	if (!pluginId) {
		return null;
	}
	return resolveMountedAppPath(`/api/ext/${pluginId}`, path);
}

export async function ownAppRequest(
	target: ApiTarget,
	pluginId: string,
	input: AppRequestInput,
	transport: MountedAppTransport = defaultTransport
): Promise<AppResponseValue> {
	if (!pluginId) {
		throw new Error("Refusing an app request outside its own sidecar mount.");
	}
	return await mountedAppRequest(
		target,
		input,
		{
			allowedMethods: METHODS,
			invalidMethodMessage: (method) =>
				`Refusing app request method ${method}.`,
			invalidPathMessage: () =>
				"Refusing an app request outside its own sidecar mount.",
			mount: `/api/ext/${pluginId}`,
		},
		transport
	);
}
