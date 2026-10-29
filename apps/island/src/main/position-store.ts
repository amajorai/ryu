import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { z } from "zod";
import type { IslandAnchor } from "./anchor.ts";
import type { Point } from "./zones.ts";

const alignSchema = z.enum(["start", "center", "end"]);

/**
 * Persisted island position on disk. Current builds store the anchor (a screen
 * point + which footprint point sits on it); older builds stored the window's
 * top-left as bare `{ x, y }`, which is still read and converted on startup.
 */
const storedPositionSchema = z.union([
	z.object({
		anchor: z.object({
			x: z.number(),
			y: z.number(),
			h: alignSchema,
			v: alignSchema,
		}),
	}),
	z.object({ x: z.number(), y: z.number() }),
]);

/** A persisted position: the anchor, or a legacy window top-left. */
export type StoredPosition =
	| { anchor: IslandAnchor; kind: "anchor" }
	| { kind: "legacy"; origin: Point };

/** Absolute path to the JSON file holding the persisted island position. */
function positionFilePath(): string {
	return join(app.getPath("userData"), "island", "window.json");
}

/** Read the persisted position, or `null` if none/invalid. */
export function readStoredPosition(): StoredPosition | null {
	try {
		const raw = readFileSync(positionFilePath(), "utf8");
		const parsed = storedPositionSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		if ("anchor" in parsed.data) {
			const { x, y, h, v } = parsed.data.anchor;
			return { kind: "anchor", anchor: { x, y, placement: { h, v } } };
		}
		return { kind: "legacy", origin: parsed.data };
	} catch {
		// No file yet, or it is corrupt: fall back to the default position.
	}
	return null;
}

/** Persist the anchor, creating the parent directory if needed. */
export function writeStoredAnchor(anchor: IslandAnchor): void {
	try {
		const file = positionFilePath();
		mkdirSync(dirname(file), { recursive: true });
		const { x, y, placement } = anchor;
		writeFileSync(
			file,
			JSON.stringify({ anchor: { x, y, h: placement.h, v: placement.v } }),
			"utf8"
		);
	} catch {
		// Persistence is best-effort; never crash the app over it.
	}
}
