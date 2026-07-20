// Shared identity for the Canvas Ryu App on the desktop side. The built-in
// creative-canvas board was ported to a full-page Companion (`com.ryu.canvas`); its
// boards are now Space documents of kind `app:com.ryu.canvas` living in the
// "Canvas" system space (seeded by Core at startup). Mirrors
// `lib/whiteboard/app.ts`.

/** The Canvas app's plugin id (matches Core `CANVAS_PLUGIN_ID`). */
export const CANVAS_PLUGIN_ID = "com.ryu.canvas";

/** The undeletable system space that holds every canvas board (Core seeds it). */
export const CANVAS_SPACE_NAME = "Canvas";

/** The app-document kind a canvas board is stored under. */
export const CANVAS_DOC_KIND = `app:${CANVAS_PLUGIN_ID}`;

/** The tab path that opens a canvas board (the app-doc route). */
export function canvasDocPath(spaceId: string, docId: string): string {
	return `/spaces/${spaceId}/app/${CANVAS_PLUGIN_ID}/${docId}`;
}
