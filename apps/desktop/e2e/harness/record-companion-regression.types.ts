export type RecordApp = "invoices" | "people" | "drawesome";
export interface RecordCall {
	input: { namespace?: string; key: string; value?: string };
	method: "storage.get" | "storage.set";
	status: "pending" | "accepted" | "refused";
}
export interface RecordCompanionApi {
	mount(input: { app: RecordApp; appHtml: string; reset?: boolean }): void;
	calls(): RecordCall[];
	connected(): boolean;
	stored(app: RecordApp): string | null;
	holdNextWrite(): void;
	releaseWrite(accept: boolean): void;
}
