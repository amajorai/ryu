// Minimal typings for `qr.js` — a dependency-free QR encoder (the same one
// react-qr-code uses under the hood). We call it directly so we can rasterize a
// scannable QR onto the agent badge canvas, rather than mounting the React/SVG
// component. See `src/lib/agent-badge.ts`.
declare module "qr.js" {
	interface QrModel {
		/** Square matrix of modules; `true` = dark cell. */
		modules: boolean[][];
	}
	interface QrOptions {
		/** Error-correction level as the encoder's numeric code (default H). */
		errorCorrectLevel?: number;
		/** QR version 1–40, or -1 to auto-fit the data. */
		typeNumber?: number;
	}
	const qr: (data: string, opt?: QrOptions) => QrModel;
	export default qr;
}
