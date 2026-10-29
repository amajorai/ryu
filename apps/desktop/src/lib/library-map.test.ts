import { describe, expect, test } from "bun:test";
import { extractCoordinates, fitBounds } from "./library-map.ts";

describe("extractCoordinates", () => {
	test("reads top-level lat/lng aliases", () => {
		expect(extractCoordinates({ lat: 1.3, lng: 103.8 })).toEqual({
			lat: 1.3,
			lng: 103.8,
		});
		expect(
			extractCoordinates({ latitude: "51.5", longitude: "-0.12" })
		).toEqual({ lat: 51.5, lng: -0.12 });
		expect(extractCoordinates({ lat: 10, lon: 20 })).toEqual({
			lat: 10,
			lng: 20,
		});
	});

	test("reads nested geo/location objects", () => {
		expect(
			extractCoordinates({ location: { latitude: 35.6, longitude: 139.7 } })
		).toEqual({ lat: 35.6, lng: 139.7 });
		expect(extractCoordinates({ geo: { lat: -33.9, lng: 151.2 } })).toEqual({
			lat: -33.9,
			lng: 151.2,
		});
	});

	test("reads GeoJSON pairs and Point geometries in [lng, lat] order", () => {
		expect(extractCoordinates({ coordinates: [2.35, 48.85] })).toEqual({
			lat: 48.85,
			lng: 2.35,
		});
		expect(
			extractCoordinates({
				geometry: { type: "Point", coordinates: [-74, 40.7] },
			})
		).toEqual({ lat: 40.7, lng: -74 });
	});

	test("reads a 'lat,lng' location string", () => {
		expect(extractCoordinates({ location: "40.7, -74.0" })).toEqual({
			lat: 40.7,
			lng: -74,
		});
	});

	test("rejects missing, non-numeric and out-of-range values", () => {
		expect(extractCoordinates({ title: "no coords" })).toBeNull();
		expect(extractCoordinates({ lat: "abc", lng: 1 })).toBeNull();
		expect(extractCoordinates({ lat: "", lng: 1 })).toBeNull();
		expect(extractCoordinates({ lat: 95, lng: 1 })).toBeNull();
		expect(extractCoordinates({ lat: 1, lng: 200 })).toBeNull();
		expect(extractCoordinates(null)).toBeNull();
		expect(extractCoordinates([1, 2])).toBeNull();
	});
});

describe("fitBounds", () => {
	test("returns null for no points", () => {
		expect(fitBounds([])).toBeNull();
	});

	test("gives a single point a minimum span", () => {
		const bounds = fitBounds([{ lat: 10, lng: 20 }], { minSpanDegrees: 2 });
		expect(bounds).toEqual({ south: 9, north: 11, west: 19, east: 21 });
	});

	test("pads the span of several points", () => {
		const bounds = fitBounds(
			[
				{ lat: 0, lng: 0 },
				{ lat: 10, lng: 20 },
			],
			{ paddingRatio: 0.1, minSpanDegrees: 0 }
		);
		expect(bounds).toEqual({ south: -1, north: 11, west: -2, east: 22 });
	});

	test("clamps to valid latitude and longitude", () => {
		const bounds = fitBounds(
			[
				{ lat: -89, lng: -179 },
				{ lat: 89, lng: 179 },
			],
			{ paddingRatio: 0.5 }
		);
		expect(bounds).toEqual({ south: -90, north: 90, west: -180, east: 180 });
	});
});
