import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { NavigationAdapter } from "./types.ts";

export function useNextJsAdapter(): NavigationAdapter {
	const router = useRouter();
	const searchParams = useSearchParams();
	const pathname = usePathname();

	return {
		navigate: (path: string) =>
			router.push(
				/* SAFETY: NavigationAdapter is router-agnostic, so callers pass paths the host app owns as plain strings; this is the documented Next nonliteral-href cast. */ path as Route
			),
		getQueryParam: (param: string) => searchParams.get(param),
		clearQueryParams: () =>
			router.replace(
				/* SAFETY: usePathname returns the pathname of the page being rendered, which is always one of this app's routes. */ pathname as Route
			),
	};
}
