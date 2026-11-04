/**
 * Sheet sides. "top", "right", "bottom" and "left" pin a sheet to that window
 * edge in any reading direction. "inline-start" and "inline-end" follow the
 * reading direction: under `dir="rtl"` the inline end is the physical left.
 */
export type PhysicalSheetSide = "top" | "right" | "bottom" | "left";
export type SheetSide = PhysicalSheetSide | "inline-start" | "inline-end";

/** Resolve a (possibly logical) sheet side to the physical edge it pins to. */
export function resolveSheetSide(
	side: SheetSide,
	direction: string | undefined
): PhysicalSheetSide {
	const rtl = direction === "rtl";
	if (side === "inline-start") {
		return rtl ? "right" : "left";
	}
	if (side === "inline-end") {
		return rtl ? "left" : "right";
	}
	return side;
}
