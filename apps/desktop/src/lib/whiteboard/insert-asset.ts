// apps/desktop/src/lib/whiteboard/insert-asset.ts
//
// Drop an AssetPicker selection (an SVG icon/logo or a GIF) onto an Excalidraw
// whiteboard. Excalidraw renders both as *image* elements backed by a registered
// file, so this: (1) turns the asset into a data URL, (2) registers it via
// `api.addFiles`, then (3) materializes an image element through the same
// `convertToExcalidrawElements` + `addElements` path the AI generator uses.

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type {
	ExcalidrawElement,
	FileId,
} from "@excalidraw/excalidraw/element/types";
import type {
	BinaryFileData,
	DataURL,
	ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { type AssetSelection, svgDataUrl } from "@/src/lib/api/assets.ts";

/** Largest side (scene px) an inserted asset is scaled to fit within. */
const MAX_SIDE = 360;
/** Fallback square size when a source reports no intrinsic dimensions. */
const DEFAULT_SIZE = 160;

/** Fetch a remote asset (e.g. a GIF) and read it as a data URL. */
async function urlToDataUrl(
	url: string
): Promise<{ dataURL: DataURL; mimeType: string }> {
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`asset fetch failed: ${resp.status}`);
	}
	const blob = await resp.blob();
	const dataURL = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("read failed"));
		reader.readAsDataURL(blob);
	});
	return { dataURL: dataURL as DataURL, mimeType: blob.type || "image/gif" };
}

/** Scale (w, h) down so the larger side is at most {@link MAX_SIDE}. */
function fitSize(
	width: number,
	height: number
): {
	width: number;
	height: number;
} {
	const w = width > 0 ? width : DEFAULT_SIZE;
	const h = height > 0 ? height : DEFAULT_SIZE;
	const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
	return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** The scene-space top-left so a (w, h) element lands centered in the viewport. */
function centeredTopLeft(
	api: ExcalidrawImperativeAPI,
	width: number,
	height: number
): { x: number; y: number } {
	const st = api.getAppState();
	const zoom = st.zoom?.value ?? 1;
	const vw = st.width ?? 800;
	const vh = st.height ?? 600;
	const centerX = vw / 2 / zoom - st.scrollX;
	const centerY = vh / 2 / zoom - st.scrollY;
	return { x: centerX - width / 2, y: centerY - height / 2 };
}

/**
 * Insert `selection` onto the board. `addElements` is the board's existing
 * append-and-scroll-into-view callback; this only additionally registers the
 * backing file first (which `addElements` alone cannot do).
 */
export async function insertAssetOntoBoard(
	api: ExcalidrawImperativeAPI,
	addElements: (els: readonly ExcalidrawElement[]) => void,
	selection: AssetSelection
): Promise<void> {
	let dataURL: DataURL;
	let mimeType: string;
	let intrinsicW = DEFAULT_SIZE;
	let intrinsicH = DEFAULT_SIZE;

	if (selection.kind === "svg") {
		dataURL = svgDataUrl(selection.svg) as DataURL;
		mimeType = "image/svg+xml";
	} else {
		const fetched = await urlToDataUrl(selection.url);
		dataURL = fetched.dataURL;
		mimeType = fetched.mimeType;
		intrinsicW =
			selection.width && selection.width > 0 ? selection.width : DEFAULT_SIZE;
		intrinsicH =
			selection.height && selection.height > 0
				? selection.height
				: DEFAULT_SIZE;
	}

	const fileId = crypto.randomUUID() as FileId;
	const file: BinaryFileData = {
		id: fileId,
		dataURL,
		mimeType: mimeType as BinaryFileData["mimeType"],
		created: Date.now(),
		lastRetrieved: Date.now(),
	};
	api.addFiles([file]);

	const { width, height } = fitSize(intrinsicW, intrinsicH);
	const { x, y } = centeredTopLeft(api, width, height);
	const elements = convertToExcalidrawElements([
		{ type: "image", fileId, x, y, width, height },
	]);
	addElements(elements);
}
