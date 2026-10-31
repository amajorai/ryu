export type RecordApp = "invoices" | "people" | "drawesome";
export interface RecordCall {
	input: { namespace?: string; key: string; value?: string };
	method: "storage.get" | "storage.set";
	status: "pending" | "accepted" | "refused";
}
export interface RecordCompanionApi {
	calls(): RecordCall[];
	connected(): boolean;
	holdNextWrite(): void;
	mount(input: { app: RecordApp; appHtml: string; reset?: boolean }): void;
	releaseWrite(accept: boolean): void;
	stored(app: RecordApp): string | null;
}
