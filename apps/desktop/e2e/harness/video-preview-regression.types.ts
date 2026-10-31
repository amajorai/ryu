export interface PreviewCall {
	body?: unknown;
	method: string;
	path: string;
	status: "pending" | "accepted" | "refused";
}
export interface VideoPreviewApi {
	calls(): PreviewCall[];
	connected(): boolean;
	holdNext(asset: "A" | "B"): void;
	ids(): { A: string; B: string };
	mount(input: { appHtml: string; imageA: string; imageB: string }): void;
	release(asset: "A" | "B", accept: boolean): void;
	renderEquivalentSelection(): void;
	select(asset: "A" | "B", held?: boolean): void;
}
