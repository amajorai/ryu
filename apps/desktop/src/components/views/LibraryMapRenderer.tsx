// Library `map` renderer: plots source rows that carry a coordinate on a
// MapLibre GL map (OpenFreeMap tiles, no API key — the same stack as the
// dashboard MapWidget). Each marker is a labelled button that opens its row.
// Loaded lazily from LibraryView so MapLibre stays out of the main bundle.

import { Location01Icon } from "@hugeicons/core-free-icons";
import type { SourceItem } from "@ryu/app-host/views";
import { LibraryEmpty } from "@ryu/blocks/desktop/library.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";
import {
	extractCoordinates,
	fitBounds,
	type LngLat,
} from "@/src/lib/library-map.ts";
import { ensureMaplibreWorker } from "@/src/lib/maplibre-worker.ts";

/** Public OpenFreeMap style — vector tiles, no key required. */
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAX_FIT_ZOOM = 14;
const FIT_PADDING_PX = 40;

interface PlottedRow {
	point: LngLat;
	row: SourceItem;
}

interface LibraryMapRendererProps {
	onOpen: (row: SourceItem) => void;
	rows: SourceItem[];
}

function markerElement(
	title: string,
	label: string,
	onClick: () => void
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className =
		"max-w-40 truncate rounded-full border border-border bg-card px-2 py-0.5 text-foreground text-xs shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
	button.textContent = title;
	button.title = title;
	button.setAttribute("aria-label", label);
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onClick();
	});
	return button;
}

export default function LibraryMapRenderer({
	onOpen,
	rows,
}: LibraryMapRendererProps) {
	const tl = useLiteralMessages();
	// Read through a ref so the marker effect does not re-run on every render.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const plotted = useMemo<PlottedRow[]>(() => {
		const out: PlottedRow[] = [];
		for (const row of rows) {
			const point = extractCoordinates(row.raw);
			if (point) {
				out.push({ point, row });
			}
		}
		return out;
	}, [rows]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const markersRef = useRef<maplibregl.Marker[]>([]);
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const hasPoints = plotted.length > 0;

	// Create the map once the container exists (only when there is something to plot).
	useEffect(() => {
		if (!(hasPoints && containerRef.current) || mapRef.current) {
			return;
		}
		ensureMaplibreWorker();
		const map = new maplibregl.Map({
			container: containerRef.current,
			style: OPENFREEMAP_STYLE,
			center: [0, 20],
			zoom: 1.2,
			attributionControl: { compact: true },
		});
		map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
		mapRef.current = map;
		return () => {
			for (const marker of markersRef.current) {
				marker.remove();
			}
			markersRef.current = [];
			map.remove();
			mapRef.current = null;
		};
	}, [hasPoints]);

	// Reconcile markers and fit the camera whenever the plotted rows change.
	useEffect(() => {
		const map = mapRef.current;
		if (!map) {
			return;
		}
		for (const marker of markersRef.current) {
			marker.remove();
		}
		markersRef.current = plotted.map(({ point, row }) =>
			new maplibregl.Marker({
				element: markerElement(
					row.item.title,
					tlRef.current("Open {title}", { title: row.item.title }),
					() => onOpenRef.current(row)
				),
			})
				.setLngLat([point.lng, point.lat])
				.addTo(map)
		);
		const bounds = fitBounds(plotted.map(({ point }) => point));
		if (bounds) {
			map.fitBounds(
				[
					[bounds.west, bounds.south],
					[bounds.east, bounds.north],
				],
				{ animate: false, maxZoom: MAX_FIT_ZOOM, padding: FIT_PADDING_PX }
			);
		}
	}, [plotted]);

	if (!hasPoints) {
		return (
			<LibraryEmpty
				description="None of these items include a latitude and longitude to plot."
				icon={Location01Icon}
				title="No locations"
			/>
		);
	}

	const unplotted = rows.length - plotted.length;
	return (
		<div className="flex flex-col gap-2">
			<div
				aria-label="Library map"
				className="h-[28rem] w-full overflow-hidden rounded-lg border"
				ref={containerRef}
				role="region"
			/>
			{unplotted > 0 ? (
				<p className="text-muted-foreground text-xs">
					{tl(
						"{unplotted} of {total} items have no location and are not shown.",
						{ total: rows.length, unplotted }
					)}
				</p>
			) : null}
		</div>
	);
}
