/** Host presentation preference, persisted in Core's shared preference store. */
export const NOTCH_PREF_KEY = "island-notch-mode";
export function parseNotchMode(raw: string | null): boolean {
	return raw === "true";
}
export interface NotchGeometry {
	displayId: number;
	height: number;
	width: number;
	x: number;
	y: number;
}
/** Center every footprint on the hardware notch and attach it to the screen edge. */
export function notchWindowRect(
	notch: NotchGeometry,
	width: number,
	height: number
) {
	return {
		x: Math.round(notch.x + (notch.width - width) / 2),
		y: notch.y,
		width,
		height,
	};
}
