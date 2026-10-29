// gifenc ships no type declarations. Only the surface `pass-studio/gif.ts` uses.
declare module "gifenc" {
	export type GifPalette = number[][];

	export interface GifFrameOptions {
		delay?: number;
		palette?: GifPalette;
		repeat?: number;
	}

	export interface GifEncoderInstance {
		bytes(): Uint8Array<ArrayBuffer>;
		finish(): void;
		writeFrame(
			index: Uint8Array,
			width: number,
			height: number,
			options?: GifFrameOptions
		): void;
	}

	export function GIFEncoder(): GifEncoderInstance;
	export function quantize(
		rgba: Uint8Array | Uint8ClampedArray,
		maxColors: number
	): GifPalette;
	export function applyPalette(
		rgba: Uint8Array | Uint8ClampedArray,
		palette: GifPalette
	): Uint8Array;
}
