import type { LiteralMessage } from "@ryu/i18n/react";
import { type ApiTarget, apiUrl, request, requestHeaders } from "./client.ts";
import { toFileIndex } from "./spaces.ts";
import { responseCodec12 } from "./spaces-response-codecs.ts";
import type { SpaceFileIndex } from "./spaces-types.ts";
import { formatBytes, SPACE_UPLOAD_MAX_BYTES } from "./spaces-upload-limits.ts";
import {
	spaceFileUploadWireSchema,
	spaceUploadErrorSchema,
} from "./spaces-wire-contracts.ts";
import type { FileIndexWire } from "./spaces-wire-types.ts";

// apps/desktop/src/lib/api/spaces-file-upload.ts
//
// Binary file documents: upload, download and revision replace. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

/**
 * What `POST /api/spaces/:id/files` answers with — the stored document, plus what
 * happened when Core tried to read its **contents**.
 *
 * {@link index} is the part callers must not skip. A 200 means the bytes are
 * stored; it does NOT mean the file is searchable. Core runs extraction on the
 * same call and reports the outcome here, and `skipped` / `failed` are three
 * different things for the user to do — see {@link SpaceFileIndex} and the table
 * on {@link SpaceFileIndexState}. A surface that renders "Uploaded ✓" off the
 * status code alone tells a user their unreadable PDF is searchable.
 */
export interface UploadedSpaceFile {
	byteSize: number;
	documentId: string;
	/** Extraction outcome, read through the same {@link toFileIndex} every other
	 *  carrier of this object uses. */
	index: SpaceFileIndex;
	mime: string;
}

/** Strip the `data:<mime>;base64,` prefix `FileReader` prepends. Core decodes the
 *  field with a plain `STANDARD.decode`, so the prefix is a `400 invalid base64`. */
function base64Payload(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

function readAsBase64(blob: Blob, label = "file"): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(base64Payload(String(reader.result ?? "")));
		reader.onerror = () =>
			reject(reader.error ?? new Error(`Couldn't read ${label}`));
		reader.readAsDataURL(blob);
	});
}

/**
 * Store `file` as a first-class file document in a Space
 * (`POST /api/spaces/:id/files`).
 *
 * ## Why `XMLHttpRequest` and not the shared {@link request}
 *
 * `fetch` reports no upload progress — there is no `onprogress` for a request
 * body — so a percentage rendered next to a `fetch` upload can only be a timer
 * pretending. This is 32 MiB of base64 over a possibly-remote node, which is
 * exactly the case where the number has to be real. Auth headers still come from
 * {@link requestHeaders}, so this path cannot drift from every other call.
 *
 * `onProgress` reports the **upload** fraction only, and is not called at all
 * while the file is being read into base64 locally: a caller should show an
 * indeterminate state until the first callback rather than animate the read.
 */
export async function uploadSpaceFile(
	target: ApiTarget,
	spaceId: string,
	file: File,
	opts?: {
		onProgress?: (fraction: number) => void;
		signal?: AbortSignal;
		tl?: LiteralMessage;
	}
): Promise<UploadedSpaceFile> {
	// Refuse locally at the same ceiling the handler enforces, so a too-large file
	// costs neither the base64 expansion nor the round trip it would be rejected on.
	if (file.size > SPACE_UPLOAD_MAX_BYTES) {
		throw new Error(
			`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(SPACE_UPLOAD_MAX_BYTES)}.`
		);
	}
	const dataBase64 = await readAsBase64(file, file.name);
	const headers = await requestHeaders(target, {
		"content-type": "application/json",
	});
	const body = JSON.stringify({
		title: file.name || "Untitled",
		mime: file.type || "application/octet-stream",
		data_base64: dataBase64,
	});
	const wire = await new Promise<{
		byte_size?: number;
		id: string;
		index?: FileIndexWire | null;
		mime?: string;
	}>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", apiUrl(target, `/api/spaces/${spaceId}/files`));
		for (const [key, value] of Object.entries(headers)) {
			xhr.setRequestHeader(key, value);
		}
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) {
				opts?.onProgress?.(e.loaded / e.total);
			}
		};
		xhr.onerror = () =>
			reject(new Error("Upload failed — the node is unreachable."));
		xhr.onabort = () => reject(new Error("Upload cancelled"));
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				let detail = opts?.tl
					? opts.tl("Upload failed ({status})", { status: xhr.status })
					: `Upload failed (${xhr.status})`;
				try {
					const parsed = spaceUploadErrorSchema.parse(
						JSON.parse(xhr.responseText)
					);
					// `app_disabled` puts the actionable sentence in `message`; every
					// other Core error puts it in `error`.
					const said = parsed.message ?? parsed.error;
					if (said) {
						detail = String(said);
					}
				} catch {
					// Non-JSON body — keep the status line.
				}
				reject(new Error(detail));
				return;
			}
			try {
				resolve(spaceFileUploadWireSchema.parse(JSON.parse(xhr.responseText)));
			} catch {
				reject(
					new Error("The node answered the upload with something not JSON.")
				);
			}
		};
		opts?.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(body);
	});
	return {
		documentId: wire.id,
		mime: wire.mime || file.type || "application/octet-stream",
		byteSize: wire.byte_size ?? file.size,
		index: toFileIndex(wire.index),
	};
}

/** Download a Space file with the same node-token and verified-user identity as
 * every JSON API call. The response is deliberately a Blob: active HTML/SVG is
 * never inserted into the app DOM, and viewers opt into only known safe formats. */
export async function fetchSpaceFileBlob(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	signal?: AbortSignal
): Promise<Blob> {
	const path = `/api/spaces/${spaceId}/documents/${documentId}/blob`;
	const response = await fetch(apiUrl(target, path), {
		headers: await requestHeaders(target),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Could not open this file (${response.status}).`);
	}
	return response.blob();
}

/** Replace a Space file revision and trigger Core's content re-indexing. */
export async function replaceSpaceFileBlob(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	blob: Blob,
	mime: string
): Promise<UploadedSpaceFile> {
	if (blob.size > SPACE_UPLOAD_MAX_BYTES) {
		throw new Error(
			`This file is ${formatBytes(blob.size)} — the limit is ${formatBytes(SPACE_UPLOAD_MAX_BYTES)}.`
		);
	}
	const dataBase64 = await readAsBase64(blob, "the edited file");
	const wire = await request<{
		byte_size?: number;
		id: string;
		index?: FileIndexWire | null;
		mime?: string;
	}>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/blob`,
		{
			method: "PUT",
			body: { data_base64: dataBase64, mime },
		},
		responseCodec12
	);
	return {
		documentId: wire.id,
		mime: wire.mime || mime,
		byteSize: wire.byte_size ?? blob.size,
		index: toFileIndex(wire.index),
	};
}
