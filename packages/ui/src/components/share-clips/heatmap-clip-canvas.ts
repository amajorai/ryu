/** Small canvas helpers for the contributions-heatmap clip. */

export const fontString = (
	family: string,
	weight: number,
	px: number,
	unit: number
): string => `${weight} ${px * unit}px ${family}`;

export function fillRoundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	radius: number
): void {
	if (typeof ctx.roundRect === "function") {
		ctx.beginPath();
		ctx.roundRect(x, y, size, size, radius);
		ctx.fill();
		return;
	}
	ctx.fillRect(x, y, size, size);
}
