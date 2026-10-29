import type { AppJsonValue } from "@ryuhq/core-client/app-request-json.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { type ApiTarget, apiUrl } from "@/src/lib/api/client.ts";

const ugcJsonValueSchema = appResponseValueSchema.nonoptional();

const ugcErrorFieldsSchema = z
	.object({
		error: ugcJsonValueSchema.nullish(),
		message: ugcJsonValueSchema.nullish(),
	})
	.catch({});

export function readUgcError(body: string, status: number): AppJsonValue {
	const fallback = body.trim() || `Request failed (${status})`;
	try {
		const parsed = ugcErrorFieldsSchema.parse(JSON.parse(body));
		return parsed.error ?? parsed.message ?? fallback;
	} catch {
		return fallback;
	}
}

/** The sidecar's public mount is deliberately independent of app-host RPC. */
export function createUgcCall(
	target: ApiTarget,
	headers: RequestInit["headers"]
) {
	const { token, url, userJwt } = target;
	return async (path: string, init?: RequestInit) => {
		const response = await fetch(
			apiUrl({ token, url, userJwt }, `/api/ugc${path}`),
			{
				headers,
				...init,
			}
		);
		const text = await response.text();
		if (!response.ok) {
			// Native Error converts the selected diagnostic outside extraction.
			// Preserve JSON-object diagnostics and their native coercion failures.
			throw new Error(String(readUgcError(text, response.status)));
		}
		return ugcJsonValueSchema.parse(text ? JSON.parse(text) : {});
	};
}
export type UgcCall = ReturnType<typeof createUgcCall>;
