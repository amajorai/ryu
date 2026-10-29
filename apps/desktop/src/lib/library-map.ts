// Pure helpers for the Library `map` renderer: pull a coordinate out of a
// source row's raw record and fit a bounding box around the plotted points.
// Kept free of MapLibre so the logic is unit-testable without a DOM/WebGL.

import { z } from "zod";

export interface LngLat {
	lat: number;
	lng: number;
}

export interface GeoBounds {
	east: number;
	north: number;
	south: number;
	west: number;
}

const LAT_KEYS = ["lat", "latitude"] as const;
const LNG_KEYS = ["lng", "lon", "long", "longitude"] as const;
/** Nested objects commonly holding a point (`{ location: { lat, lng } }`). */
const NESTED_KEYS = [
	"geo",
	"location",
	"coordinates",
	"coords",
	"position",
	"point",
	"geometry",
] as const;
const MAX_NESTING = 3;

/** A candidate coordinate projection, not a claim about the complete source
 * record. Nested candidates and scalar coordinates are parsed when consumed. */
const coordinateCandidateSchema = z.object({
	lat: z.unknown().optional(),
	latitude: z.unknown().optional(),
	lng: z.unknown().optional(),
	lon: z.unknown().optional(),
	long: z.unknown().optional(),
	longitude: z.unknown().optional(),
	geo: z.unknown().optional(),
	location: z.unknown().optional(),
	coordinates: z.unknown().optional(),
	coords: z.unknown().optional(),
	position: z.unknown().optional(),
	point: z.unknown().optional(),
	geometry: z.unknown().optional(),
	type: z.unknown().optional(),
});
const coordinatePairSchema = z.array(z.unknown()).min(2);
type CoordinateCandidate = z.output<typeof coordinateCandidateSchema>;
type CoordinateInput = Parameters<typeof coordinateCandidateSchema.parse>[0];
type CoordinateAxisKey = (typeof LAT_KEYS)[number] | (typeof LNG_KEYS)[number];

function finiteNumber(value: CoordinateInput): number | null {
	const number = z.number().safeParse(value);
	if (number.success) {
		return number.data;
	}
	const text = z.string().safeParse(value);
	if (!text.success || text.data.trim() === "") {
		return null;
	}
	const parsed = z.number().safeParse(Number(text.data.trim()));
	return parsed.success ? parsed.data : null;
}

function asRecord(value: CoordinateInput): CoordinateCandidate | null {
	const parsed = coordinateCandidateSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function validPoint(lat: number | null, lng: number | null): LngLat | null {
	if (lat === null || lng === null) {
		return null;
	}
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
		return null;
	}
	return { lat, lng };
}

function firstNumber(
	record: CoordinateCandidate,
	keys: readonly CoordinateAxisKey[]
): number | null {
	for (const key of keys) {
		const value = finiteNumber(record[key]);
		if (value !== null) {
			return value;
		}
	}
	return null;
}

/** GeoJSON order: `[lng, lat]`. */
function fromPair(value: CoordinateInput): LngLat | null {
	const parsed = coordinatePairSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return validPoint(finiteNumber(parsed.data[1]), finiteNumber(parsed.data[0]));
}

/** `"lat,lng"` — the order people type into a location field. */
function fromString(value: CoordinateInput): LngLat | null {
	const parsed = z.string().safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const parts = parsed.data.split(",");
	if (parts.length !== 2) {
		return null;
	}
	return validPoint(finiteNumber(parts[0]), finiteNumber(parts[1]));
}

function fromRecord(record: CoordinateCandidate, depth: number): LngLat | null {
	const direct = validPoint(
		firstNumber(record, LAT_KEYS),
		firstNumber(record, LNG_KEYS)
	);
	if (direct) {
		return direct;
	}
	// A GeoJSON geometry (`{ type: "Point", coordinates: [lng, lat] }`).
	if (record.type === "Point") {
		const point = fromPair(record.coordinates);
		if (point) {
			return point;
		}
	}
	if (depth >= MAX_NESTING) {
		return null;
	}
	for (const key of NESTED_KEYS) {
		const nested = record[key];
		const nestedRecord = asRecord(nested);
		const point =
			fromPair(nested) ??
			fromString(nested) ??
			(nestedRecord ? fromRecord(nestedRecord, depth + 1) : null);
		if (point) {
			return point;
		}
	}
	return null;
}

/**
 * Extract a coordinate from a row's raw record. Recognised shapes:
 * top-level `lat`/`latitude` + `lng`/`lon`/`long`/`longitude`; the same keys
 * nested under `geo`/`location`/`coordinates`/`coords`/`position`/`point`/
 * `geometry`; a GeoJSON `[lng, lat]` pair or `Point` geometry; and a
 * `"lat,lng"` string. Out-of-range or non-numeric values yield `null`.
 */
export function extractCoordinates(raw: CoordinateInput): LngLat | null {
	const record = asRecord(raw);
	return record ? fromRecord(record, 0) : null;
}

/**
 * Fit a bounding box around `points`, padded by `paddingRatio` of the span on
 * each side (at least `minSpanDegrees` wide so a single point is not a zero-
 * area box), clamped to valid latitude/longitude. `null` for no points.
 */
export function fitBounds(
	points: readonly LngLat[],
	{
		paddingRatio = 0.1,
		minSpanDegrees = 0.02,
	}: { minSpanDegrees?: number; paddingRatio?: number } = {}
): GeoBounds | null {
	const [first, ...rest] = points;
	if (!first) {
		return null;
	}
	let south = first.lat;
	let north = first.lat;
	let west = first.lng;
	let east = first.lng;
	for (const point of rest) {
		south = Math.min(south, point.lat);
		north = Math.max(north, point.lat);
		west = Math.min(west, point.lng);
		east = Math.max(east, point.lng);
	}
	const latPad = Math.max((north - south) * paddingRatio, minSpanDegrees / 2);
	const lngPad = Math.max((east - west) * paddingRatio, minSpanDegrees / 2);
	return {
		south: Math.max(-90, south - latPad),
		north: Math.min(90, north + latPad),
		west: Math.max(-180, west - lngPad),
		east: Math.min(180, east + lngPad),
	};
}
