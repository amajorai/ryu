export interface NavigationAdapter {
	clearQueryParams: () => void;
	getQueryParam: (param: string) => string | null;
	navigate: (path: string) => void;
}
