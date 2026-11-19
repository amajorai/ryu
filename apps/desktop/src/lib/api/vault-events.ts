// Opens Core's value-free vault change stream (`GET /api/vault/events`)
// through the Desktop's authenticated fetch, and reads it with core-client's
// frame parser. Events carry coordinates only, never a value.

import {
	readVaultEventFrames,
	type VaultEventMessage,
} from "@ryuhq/core-client/vault-events";
import { ApiError, type ApiTarget, authenticatedFetch } from "./client.ts";

const PATH = "/api/vault/events";

export async function openVaultChangeStream(
	target: ApiTarget,
	signal: AbortSignal
): Promise<AsyncGenerator<VaultEventMessage>> {
	const response = await authenticatedFetch(target, PATH, {
		headers: { Accept: "text/event-stream" },
		signal,
	});
	if (!(response.ok && response.body)) {
		throw new ApiError(PATH, response.status);
	}
	return readVaultEventFrames(response.body);
}
