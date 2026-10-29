import {
	uploadErrorViewSchema,
	uploadLegacyViewSchema,
} from "@ryuhq/core-client/upload-wire-contracts.ts";
import { z } from "zod";
// apps/desktop/src/lib/api/uploads.ts
//
// User file uploads → Core's Uploads system space (`POST /api/uploads`). Chat
// attachments, page/editor media, and `ui.uploadFile` all share this path so
// bytes land as first-class Space file documents (not `~/.ryu/media/`).

import { type ApiTarget, authenticatedFetch } from "./client.ts";

/** A stored upload. `url` is relative (`/api/uploads/<id>`); callers prepend the
 *  node base when rendering. */
export interface UploadObject {
	contentType: string;
	fileName: string;
	id: string;
	size: number;
	spaceId: string;
	/** Relative serve path (`/api/uploads/<id>`). */
	url: string;
}

/** Read a File into a `data:` URL (for AI-SDK multimodal file parts). */
export function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = z.string().safeParse(reader.result);
			if (dataUrl.success) {
				resolve(dataUrl.data);
			} else {
				reject(new Error(`failed to read ${file.name}`));
			}
		};
		reader.onerror = () => {
			reject(reader.error ?? new Error(`failed to read ${file.name}`));
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Persist `file` into the Uploads system space. Returns the stored object; the
 * absolute URL for rendering is `target.url + result.url`.
 */
export async function uploadUserFile(
	target: ApiTarget,
	file: File | Blob,
	opts?: { fileName?: string; signal?: AbortSignal }
): Promise<UploadObject> {
	const fileName =
		opts?.fileName ??
		(file instanceof File && file.name ? file.name : "upload");
	// The name travels as `?name=`, not `x-filename`: a header value must be a
	// ByteString (fetch throws on U+202F in macOS screenshot names, CJK, emoji)
	// and Core reads the header with `to_str`, which drops any Latin-1 name.
	const headers = {
		"content-type": file.type || "application/octet-stream",
	};
	const path = `/api/uploads?name=${encodeURIComponent(fileName)}`;
	const res = await authenticatedFetch(target, path, {
		method: "POST",
		headers,
		body: file,
		signal: opts?.signal,
	});
	if (!res.ok) {
		let detail = "";
		try {
			const err = uploadErrorViewSchema.parse(await res.json());
			detail = err.error ? `: ${err.error}` : "";
		} catch {
			// ignore
		}
		throw new Error(`Upload failed (${res.status})${detail}`);
	}
	const data = uploadLegacyViewSchema.parse(await res.json());
	return {
		id: data.id,
		spaceId: data.space_id ?? "",
		fileName: data.file_name ?? fileName,
		url: data.url,
		size: data.size ?? (file instanceof Blob ? file.size : 0),
		contentType: data.content_type || file.type || "application/octet-stream",
	};
}

/**
 * Stage a chat/composer image: keep a `data:` URL for the model turn, and
 * persist into Uploads in parallel (best-effort — model send must not fail if
 * the Spaces write hiccups).
 */
export async function stageImageUpload(
	target: ApiTarget,
	file: File
): Promise<{ dataUrl: string; upload: UploadObject | null }> {
	const dataUrlPromise = fileToDataUrl(file);
	const uploadPromise = uploadUserFile(target, file).catch((err) => {
		console.warn("[uploads] failed to persist chat attachment:", err);
		return null;
	});
	const [dataUrl, upload] = await Promise.all([dataUrlPromise, uploadPromise]);
	return { dataUrl, upload };
}
