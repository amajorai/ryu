// apps/desktop/src/lib/query-client.ts
//
// App-wide TanStack Query client. Catalog data (models, skills) changes slowly,
// so we keep a generous staleTime — revisiting a model you already opened is then
// instant (served from cache) instead of refetching from Core/Hugging Face on
// every navigation. Window-focus refetch is off because this is a desktop shell,
// not a dashboard that needs to chase live data.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});
