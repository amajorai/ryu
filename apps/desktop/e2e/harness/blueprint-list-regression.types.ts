export interface BlueprintListCall {
	body?: unknown;
	method: string;
	path: string;
	status: "pending" | "accepted" | "refused";
}
export interface BlueprintListApi {
	calls(): BlueprintListCall[];
	connected(): boolean;
	holdNextDetail(): void;
	mount(input: {
		appHtml: string;
		detailFailures?: number;
		listFailures?: number;
		revisionFailures?: number;
	}): void;
	releaseDetail(): void;
	setPersistedRevision(revision: number): void;
}
