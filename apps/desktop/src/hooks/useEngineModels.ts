// apps/desktop/src/hooks/useEngineModels.ts
//
// The per-engine chat-model catalog, fetched from Core (`/api/engines/models`).
// Core owns this list so desktop/CLI/mobile show the same swappable defaults;
// `models.ts` keeps a tiny local copy only as an offline fallback. Cached for an
// hour since the catalog is near-static.

import { useQuery } from "@tanstack/react-query";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { fetchEngineModels } from "@/src/lib/api/engines.ts";
import { useActiveNode } from "./useActiveNode.ts";

const ONE_HOUR_MS = 1000 * 60 * 60;

// Stable empty map returned while the query is pending, so a consumer memo keyed
// on the result (e.g. the canvas registry) doesn't churn every render during load.
const EMPTY_MODELS: Record<string, ModelOption[]> = {};

/** Map of engine id → model options, or `{}` until the first load resolves. */
export function useEngineModels(): Record<string, ModelOption[]> {
	const node = useActiveNode();
	const { data } = useQuery({
		queryKey: ["engine-models", node.url],
		queryFn: () =>
			fetchEngineModels({ url: node.url, token: node.token ?? null }),
		staleTime: ONE_HOUR_MS,
	});
	return data ?? EMPTY_MODELS;
}
