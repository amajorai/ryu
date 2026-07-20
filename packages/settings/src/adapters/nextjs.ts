import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { NavigationAdapter } from "./types.ts";

export function useNextJsAdapter(): NavigationAdapter {
	const router = useRouter();
	const searchParams = useSearchParams();
	const pathname = usePathname();

	return {
		navigate: (path: string) => router.push(path as Route),
		getQueryParam: (param: string) => searchParams.get(param),
		clearQueryParams: () => router.replace(pathname as Route),
	};
}
