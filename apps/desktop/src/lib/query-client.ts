// apps/desktop/src/lib/query-client.ts
//
// App-wide TanStack Query client. Catalog data (models, skills) changes slowly,
// so we keep a generous staleTime — revisiting a model you already opened is then
// instant (served from cache) instead of refetching from Core/Hugging Face on
// every navigation. Window-focus refetch is off by DEFAULT because this is a
// desktop shell, not a dashboard that needs to chase live data; the few queries
// that must chase it (git status / worktree state — see `useGitStatus.ts`) opt
// back in per query.

import { focusManager, QueryClient } from "@tanstack/react-query";

import { observeQueryFocus } from "./query-focus.ts";

// Native window blur/focus and browser visibility both matter: without the
// false transition, every interval continues polling in the background and
// returning to a stale query cannot reliably trigger a fresh focus event.
focusManager.setEventListener((handleFocus) => {
	if (globalThis.window === undefined) {
		return;
	}
	return observeQueryFocus(handleFocus);
});

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
