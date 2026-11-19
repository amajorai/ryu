// Folder creation (`POST /api/vault/folders`). An empty folder is kept so it
// can be picked before any value is saved in it. Core has no folder move.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const createdReply = z.object({ ok: z.boolean(), path: z.string() });

/** Create `path` in `environment`; resolves to the normalized path Core kept. */
export async function createVaultFolder(
	target: ApiTarget,
	input: { environment: string; path: string }
): Promise<string> {
	const raw = await request(
		target,
		"/api/vault/folders",
		{ method: "POST", body: input },
		createdReply
	);
	return raw.path;
}
