// Build a single ApiTarget for the running Ryu Core node from the environment.
//
// RYU_CORE_URL  - base URL of the Core node (default http://127.0.0.1:7980)
// RYU_CORE_TOKEN - optional bearer token; pass null (no header) when unset

import type { ApiTarget } from "@ryuhq/core-client/client";

const DEFAULT_CORE_URL = "http://127.0.0.1:7980";

export const buildTarget = (): ApiTarget => {
	const url = process.env.RYU_CORE_URL?.trim() || DEFAULT_CORE_URL;
	const token = process.env.RYU_CORE_TOKEN?.trim() || null;
	return { url, token };
};
