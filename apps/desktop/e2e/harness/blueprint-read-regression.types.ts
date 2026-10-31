export interface BlueprintReadCall {
	body?: unknown;
	method: string;
	path: string;
	status: "pending" | "accepted" | "refused";
}
export interface BlueprintReadApi {
	calls(): BlueprintReadCall[];
	connected(): boolean;
	holdNextDetail(): void;
	mount(input: {
		appHtml: string;
		detailFailures?: number;
		revisionFailures?: number;
	}): void;
	releaseDetail(): void;
	setPersistedRevision(revision: number): void;
}
