import { OUTPUT_SIZE } from "./glyph-picker-constants.ts";

const loadImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", reject);
		image.src = url;
	});

export async function cropToDataUrl(
	imageSrc: string,
	zoom: number,
	mime: "image/jpeg" | "image/png" = "image/jpeg"
): Promise<string | null> {
	const image = await loadImage(imageSrc);
	const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
	const sx = (image.naturalWidth - side) / 2;
	const sy = (image.naturalHeight - side) / 2;

	const canvas = document.createElement("canvas");
	canvas.width = OUTPUT_SIZE;
	canvas.height = OUTPUT_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(image, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
	return canvas.toDataURL(mime, mime === "image/jpeg" ? 0.9 : undefined);
}
