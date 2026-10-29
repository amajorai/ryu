export interface BlueprintListCall {
	method: string;
	path: string;
	body?: unknown;
	status: "pending" | "accepted" | "refused";
}
export interface BlueprintListApi {
	mount(input: {
		appHtml: string;
		detailFailures?: number;
		listFailures?: number;
		revisionFailures?: number;
	}): void;
	calls(): BlueprintListCall[];
	connected(): boolean;
	setPersistedRevision(revision: number): void;
	holdNextDetail(): void;
	releaseDetail(): void;
}
