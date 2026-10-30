/** Image helpers for the avatar cropper: load a data URL and crop it to a blob. */

// Define type for pixel crop area
export interface Area {
	height: number;
	width: number;
	x: number;
	y: number;
}

// Helper function to create a cropped image blob
export const createImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", (error) => reject(error));
		image.setAttribute("crossOrigin", "anonymous"); // Needed for canvas Tainted check
		image.src = url;
	});

export async function getCroppedImg(
	imageSrc: string,
	pixelCrop: Area,
	outputWidth: number = pixelCrop.width,
	outputHeight: number = pixelCrop.height
): Promise<Blob | null> {
	try {
		const image = await createImage(imageSrc);
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");

		if (!ctx) {
			return null;
		}

		// Set canvas size to desired output size
		canvas.width = outputWidth;
		canvas.height = outputHeight;

		// Draw the cropped image onto the canvas
		ctx.drawImage(
			image,
			pixelCrop.x,
			pixelCrop.y,
			pixelCrop.width,
			pixelCrop.height,
			0,
			0,
			outputWidth,
			outputHeight
		);

		// Convert canvas to blob
		return new Promise((resolve) => {
			canvas.toBlob((blob) => {
				resolve(blob);
			}, "image/jpeg");
		});
	} catch (error) {
		console.error("Error in getCroppedImg:", error);
		return null;
	}
}
