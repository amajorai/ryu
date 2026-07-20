// The Whiteboard Ryu App's plugin id. The built-in whiteboard editor was ported to
// a full-page Companion app that OWNS its Space documents (kind
// `app:com.ryu.whiteboard`), so creating or opening a whiteboard routes to the
// app's Companion instead of the removed `SpaceWhiteboardEditorPage`. Must match the
// Core manifest id (`apps/core/src/plugin_manifest::WHITEBOARD_PLUGIN_ID`) and the
// default-on seed.
export const WHITEBOARD_PLUGIN_ID = "com.ryu.whiteboard";

/** The undeletable system space that holds every whiteboard (Core seeds it). */
export const WHITEBOARD_SPACE_NAME = "Whiteboard";

/** The app-document kind a whiteboard is stored under. */
export const WHITEBOARD_DOC_KIND = `app:${WHITEBOARD_PLUGIN_ID}`;

/** The tab path that opens a whiteboard (the app-doc route). */
export function whiteboardDocPath(spaceId: string, docId: string): string {
	return `/spaces/${spaceId}/app/${WHITEBOARD_PLUGIN_ID}/${docId}`;
}
