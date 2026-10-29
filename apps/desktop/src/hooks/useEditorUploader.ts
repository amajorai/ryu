import { setEditorUploader } from "@ryu/ui/lib/editor-upload.ts";
import { useEffect } from "react";
import { uploadUserFile } from "@/src/lib/api/uploads.ts";
import { useActiveNodeGetter } from "./useActiveNode.ts";

/**
 * Registers the editor's media uploader against Core's Uploads system space
 * (`POST /api/uploads` → Spaces file doc). Images pasted/dropped into a Plate
 * page are stored as first-class Space documents and served back over
 * `GET /api/uploads/<id>`, so the webview can render them via an absolute URL.
 * The active node is read at upload time, so per-tab node overrides are honored.
 */
export function useEditorUploader(): void {
	const getNode = useActiveNodeGetter();

	useEffect(() => {
		setEditorUploader(async (file) => {
			const node = getNode();
			const base = node.url.replace(/\/$/, "");
			const uploaded = await uploadUserFile(
				{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
				file
			);
			return {
				url: base + uploaded.url,
				name: uploaded.fileName,
				size: uploaded.size,
				type: file.type || uploaded.contentType,
			};
		});
		return () => setEditorUploader(null);
	}, [getNode]);
}
