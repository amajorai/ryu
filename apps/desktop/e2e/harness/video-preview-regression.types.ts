export interface PreviewCall {
	path: string;
	method: string;
	body?: unknown;
	status: "pending" | "accepted" | "refused";
}
export interface VideoPreviewApi {
	mount(input: { appHtml: string; imageA: string; imageB: string }): void;
	connected(): boolean;
	calls(): PreviewCall[];
	select(asset: "A" | "B", held?: boolean): void;
	renderEquivalentSelection(): void;
	holdNext(asset: "A" | "B"): void;
	release(asset: "A" | "B", accept: boolean): void;
	ids(): { A: string; B: string };
}
