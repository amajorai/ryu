// Map widget: a MapLibre GL map using OpenFreeMap tiles (no API key). Markers come
// from the widget value; center/zoom from config. The map instance is created once
// and markers are reconciled when the value changes.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { asRecord, resolveArray, toNumber } from "./data.ts";
import { mapConfigSchema, parseConfig } from "./schema.ts";

/** Public OpenFreeMap style — vector tiles, no key required. */
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

interface Marker {
	label?: string;
	lat: number;
	lng: number;
}

function parseMarkers(value: unknown, key?: string): Marker[] {
	const out: Marker[] = [];
	for (const m of resolveArray(value, key)) {
		const r = asRecord(m);
		if (!r) {
			continue;
		}
		const lng = toNumber(r.lng ?? r.lon ?? r.longitude);
		const lat = toNumber(r.lat ?? r.latitude);
		if (lng === null || lat === null) {
			continue;
		}
		const marker: Marker = { lng, lat };
		if (typeof r.label === "string") {
			marker.label = r.label;
		}
		out.push(marker);
	}
	return out;
}

export function MapBody({
	value,
	config,
}: {
	value: unknown;
	config: unknown;
}) {
	const cfg = parseConfig(mapConfigSchema, config);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const markersRef = useRef<maplibregl.Marker[]>([]);

	// Create the map once.
	useEffect(() => {
		if (!containerRef.current || mapRef.current) {
			return;
		}
		const map = new maplibregl.Map({
			container: containerRef.current,
			style: OPENFREEMAP_STYLE,
			center: cfg.center ?? [0, 20],
			zoom: cfg.zoom ?? 1.2,
			attributionControl: false,
		});
		mapRef.current = map;
		return () => {
			for (const m of markersRef.current) {
				m.remove();
			}
			markersRef.current = [];
			map.remove();
			mapRef.current = null;
		};
		// Center/zoom changes are applied in the reconcile effect, not on re-create.
		// biome-ignore lint/correctness/useExhaustiveDependencies: map is created once
	}, [cfg.zoom, cfg.center]);

	// Reconcile markers + camera when the value or config changes.
	useEffect(() => {
		const map = mapRef.current;
		if (!map) {
			return;
		}
		for (const m of markersRef.current) {
			m.remove();
		}
		const markers = parseMarkers(value, cfg.markers_key);
		markersRef.current = markers.map((mk) => {
			const marker = new maplibregl.Marker().setLngLat([mk.lng, mk.lat]);
			if (mk.label) {
				marker.setPopup(new maplibregl.Popup().setText(mk.label));
			}
			marker.addTo(map);
			return marker;
		});
		if (cfg.center) {
			map.setCenter(cfg.center);
		}
		if (typeof cfg.zoom === "number") {
			map.setZoom(cfg.zoom);
		}
	}, [value, cfg.markers_key, cfg.center, cfg.zoom]);

	return (
		<div
			className="h-full w-full overflow-hidden rounded-md"
			ref={containerRef}
		/>
	);
}
