import { setEditorUploader } from "@ryu/ui/lib/editor-upload";
import { useEffect } from "react";
import { useActiveNodeGetter } from "./useActiveNode.ts";

/**
 * Registers the editor's media uploader against Core's LOCAL media store
 * (`POST /api/media/upload` → `~/.ryu/media/...`). Images pasted/dropped into a
 * Plate page are stored on the machine and served back over Core's HTTP, so the
 * webview can render them via an absolute URL. This replaces the editor
 * template's cloud uploadthing default. The active node is read at upload time,
 * so per-tab node overrides are honored.
 */
export function useEditorUploader(): void {
	const getNode = useActiveNodeGetter();

	useEffect(() => {
		setEditorUploader(async (file) => {
			const node = getNode();
			const base = node.url.replace(/\/$/, "");
			const headers: Record<string, string> = {
				"x-filename": file.name,
				"content-type": file.type || "application/octet-stream",
			};
			if (node.token) {
				headers.authorization = `Bearer ${node.token}`;
			}
			const res = await fetch(`${base}/api/media/upload`, {
				method: "POST",
				headers,
				body: file,
			});
			if (!res.ok) {
				throw new Error(`Image upload failed (${res.status})`);
			}
			const data = (await res.json()) as {
				url: string;
				content_type?: string;
			};
			return {
				url: base + data.url,
				name: file.name,
				size: file.size,
				type: file.type || data.content_type || "application/octet-stream",
			};
		});
		return () => setEditorUploader(null);
	}, [getNode]);
}
