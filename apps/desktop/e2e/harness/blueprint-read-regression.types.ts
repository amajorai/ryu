export interface BlueprintReadCall {
	method: string;
	path: string;
	body?: unknown;
	status: "pending" | "accepted" | "refused";
}
export interface BlueprintReadApi {
	mount(input: {
		appHtml: string;
		detailFailures?: number;
		revisionFailures?: number;
	}): void;
	calls(): BlueprintReadCall[];
	connected(): boolean;
	setPersistedRevision(revision: number): void;
	holdNextDetail(): void;
	releaseDetail(): void;
}
