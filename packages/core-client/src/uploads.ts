import {
	uploadErrorViewSchema,
	uploadLegacyViewSchema,
} from "./upload-wire-contracts.ts";
// packages/core-client/src/uploads.ts
//
// User file uploads → Core's Uploads system space (`POST /api/uploads`). Shared
// by native/mobile; desktop has a twin in `apps/desktop/src/lib/api/uploads.ts`
// that also carries desktop identity headers.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

/** A stored upload. `url` is relative (`/api/uploads/<id>`). */
export interface UploadObject {
	contentType: string;
	fileName: string;
	id: string;
	size: number;
	spaceId: string;
	url: string;
}

/** Persist bytes into the Uploads system space. */
export async function uploadUserFile(
	target: ApiTarget,
	bytes: ArrayBuffer | Blob,
	opts: {
		contentType?: string;
		fileName: string;
		signal?: AbortSignal;
	}
): Promise<UploadObject> {
	const headers = makeHeaders(target.token, target.userJwt);
	// Raw body — override JSON content-type from makeHeaders.
	headers["Content-Type"] = opts.contentType || "application/octet-stream";
	headers["x-filename"] = opts.fileName;

	const res = await fetchForTarget(target)(apiUrl(target, "/api/uploads"), {
		method: "POST",
		headers,
		body: bytes,
		signal: opts.signal,
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
		fileName: data.file_name ?? opts.fileName,
		url: data.url,
		size: data.size ?? (bytes instanceof Blob ? bytes.size : bytes.byteLength),
		contentType:
			data.content_type || opts.contentType || "application/octet-stream",
	};
}
