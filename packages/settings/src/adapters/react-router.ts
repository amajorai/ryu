import { useNavigate, useSearchParams } from "react-router-dom";

import type { NavigationAdapter } from "./types.ts";

export function useReactRouterAdapter(): NavigationAdapter {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();

	return {
		navigate: (path: string) => navigate(path),
		getQueryParam: (param: string) => searchParams.get(param),
		clearQueryParams: () => {
			setSearchParams({});
		},
	};
}
