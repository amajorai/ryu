// Swappable, transport-agnostic uploader for the editor's media (images / files).
//
// `@ryu/ui` must not know about Core URLs or the active node, so the host app
// (the desktop) registers an uploader that persists the bytes wherever it wants
// — for Ryu that is Core's LOCAL media store (`POST /api/media/upload`,
// `~/.ryu/media/...`) — and returns a URL the editor can render in an <img>.
//
// Default (no host registered): an in-memory object URL. That keeps the editor
// usable with no backend, but such URLs are NOT persisted across reloads. The
// desktop replaces it at startup with a Core-backed uploader so images survive.

export interface EditorUploadResult {
	name: string;
	size: number;
	type: string;
	/** Absolute URL the editor can render (host resolves Core base + path). */
	url: string;
}

export type EditorUploader = (
	file: File,
	onProgress?: (percent: number) => void
) => Promise<EditorUploadResult>;

const objectUrlUploader: EditorUploader = (file) =>
	Promise.resolve({
		url: URL.createObjectURL(file),
		name: file.name,
		size: file.size,
		type: file.type,
	});

let activeUploader: EditorUploader = objectUrlUploader;

/** Host apps register their persistent uploader here. Pass null to reset. */
export function setEditorUploader(uploader: EditorUploader | null): void {
	activeUploader = uploader ?? objectUrlUploader;
}

/** The editor's media hook reads the current uploader through this. */
export function getEditorUploader(): EditorUploader {
	return activeUploader;
}
