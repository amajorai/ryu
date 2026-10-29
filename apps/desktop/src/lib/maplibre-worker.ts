// MapLibre GL 6 ships as ES modules only, and a bundler cannot resolve its worker
// from `import.meta.url`, so each consumer registers the worker URL once before the
// first `Map` is created. Vite emits the worker as a same-origin asset (`'self'`).

import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

let workerConfigured = false;

/** Register the MapLibre worker URL once; safe to call before every map. */
export function ensureMaplibreWorker(): void {
	if (workerConfigured) {
		return;
	}
	setWorkerUrl(workerUrl);
	workerConfigured = true;
}
