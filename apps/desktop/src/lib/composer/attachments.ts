// apps/desktop/src/lib/composer/attachments.ts
//
// The ONE composer attachment seam.
//
// Every composer in the desktop — the chat page, the Ask-Ryu dock / builder panes
// (`useComposerSlot`), and the launchpad empty state — used to carry its own
// `addImages` that did the same two things: filter `files` to `image/*` and drop
// the rest. Silently. A PDF dragged into chat produced no chip, no toast, no error,
// and no request; the same drop was filtered a second time server-side. Three
// copies of one bug.
//
// This module is that logic, once. A surface wires `stageComposerFiles` into its
// picker/paste/drop handlers and renders the resulting `AttachedImage[]`; the rules
// for what is accepted, how a document becomes model-readable text, and what the
// user is told when it cannot, live here and nowhere else.

import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchParseCapability,
	parseDocument,
} from "@/src/lib/api/documents.ts";
import { stageImageUpload } from "@/src/lib/api/uploads.ts";

/** A staged composer attachment. Images and documents share one list and one chip. */
export type ComposerAttachment = AttachedImage & {
	error?: string;
	state?: "processing" | "done" | "error";
};

/**
 * The `accept` used before (or instead of) Core's answer.
 *
 * Deliberately generous rather than clever: a file the bound backend cannot read is
 * refused with a reason on the chip, which is strictly better than a picker that
 * silently hides it. The authoritative list comes from
 * `GET /api/documents/parse/capability` — see {@link resolveAcceptAttribute}.
 */
export const FALLBACK_ACCEPT =
	"image/*,.pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.xls,.xlsx,.csv,.tsv,.txt,.md,.markdown,.rst,.org,.html,.htm,.xml,.json,.yaml,.yml,.eml,.msg,.epub,.log";

/**
 * Cap on a document submitted to `POST /api/documents/parse`.
 *
 * Mirrors Core's `document_parse::MAX_PARSE_BYTES` (= `MAX_UPLOAD_BYTES`, 32 MiB).
 * Checked here as well as there because the route's `DefaultBodyLimit` rejects an
 * oversized body at the *layer*, before the handler's `{ code: "too_large" }` JSON
 * can run — so without this the chip would read a bare `Request failed (413)` after
 * uploading 50 MiB to learn nothing. `GET .../capability` reports the authoritative
 * number as `max_input_bytes`; this constant is the answer before it is asked.
 */
export const MAX_PARSE_BYTES = 32 * 1024 * 1024;

/** Cached per node URL so every composer mount does not re-probe the same node. */
const acceptCache = new Map<string, string>();

/**
 * The `accept` attribute for a file picker on `target`, taken from the bound
 * `document.parse` backend where it can be reached.
 *
 * Never throws and never blocks a picker: an unreachable node, a disabled provider,
 * or a sleeping sidecar all fall back to {@link FALLBACK_ACCEPT}. Asking is an
 * optimisation (it narrows the picker to what will actually work); being unable to
 * ask must not make attaching harder than it was.
 *
 * "Unable to ask" includes the answer arriving *empty of provider formats*, which is
 * the common cold-start case and the subtle one. Core deliberately does not wake a
 * lazy sidecar to answer the capability probe, so on a fresh session the bound
 * backend contributes nothing and Core replies with the builtin floor alone — a 200,
 * `available: true`, and no `.pdf`. Trusting that as the picker's `accept` (and
 * caching it) would hide PDFs behind the "+" button for the rest of the session
 * while drag and paste still worked: the original bug, wearing the button.
 *
 * So the surplus over `builtin_extensions` is the signal. No surplus ⇒ the backend
 * did not answer ⇒ union with {@link FALLBACK_ACCEPT} and do NOT cache, so the next
 * mount asks again once the sidecar is awake.
 */
export async function resolveAcceptAttribute(
	target: ApiTarget
): Promise<string> {
	const cached = acceptCache.get(target.url);
	if (cached) {
		return cached;
	}
	try {
		const capability = await fetchParseCapability(target);
		const builtin = new Set(capability.builtinExtensions);
		const fromProvider = capability.extensions.filter(
			(ext) => !builtin.has(ext)
		);
		if (fromProvider.length === 0) {
			return FALLBACK_ACCEPT;
		}
		const accept = ["image/*", ...capability.extensions].join(",");
		acceptCache.set(target.url, accept);
		return accept;
	} catch {
		return FALLBACK_ACCEPT;
	}
}

/**
 * Open a native file picker with the node's real accept list and hand back the
 * chosen files. Shared so no surface hardcodes `image/*` again.
 */
export function openAttachPicker(
	target: ApiTarget,
	onFiles: (files: File[]) => void
): void {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	// Set immediately so the click is not gated on a network round trip, then
	// narrowed once Core answers (usually before the user has picked anything).
	input.accept = acceptCache.get(target.url) ?? FALLBACK_ACCEPT;
	void resolveAcceptAttribute(target).then((accept) => {
		input.accept = accept;
	});
	input.onchange = () => {
		if (input.files) {
			onFiles(Array.from(input.files));
		}
	};
	input.click();
}

/** A React-style setter over the staged list. */
type Update = (
	updater: (prev: ComposerAttachment[]) => ComposerAttachment[]
) => void;

let attachmentSeq = 0;

function nextId(prefix: string): string {
	attachmentSeq += 1;
	return `${prefix}-${Date.now()}-${attachmentSeq}`;
}

/**
 * Encode extracted markdown as a `data:` URL.
 *
 * Base64 over UTF-8 bytes, not `btoa(text)`: `btoa` throws on any character above
 * U+00FF, so a document containing an em dash — let alone Japanese — would fail to
 * attach. `encodeURIComponent`/`unescape` round-trips through UTF-8 correctly.
 */
export function markdownToDataUrl(markdown: string): string {
	const bytes = new TextEncoder().encode(markdown);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `data:text/markdown;base64,${btoa(binary)}`;
}

/** Encode UTF-8 text as a plain-text data URL for a staged composer file. */
export function textToDataUrl(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `data:text/plain;base64,${btoa(binary)}`;
}

/**
 * Extensions read as plain text without Core's `document.parse` facade. Core
 * decodes any `text/*` file part straight into an `<attached-document>` block, so
 * these ride the same staged list as images, today, on every node.
 */
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
	"c",
	"cpp",
	"css",
	"csv",
	"go",
	"h",
	"htm",
	"html",
	"ini",
	"java",
	"js",
	"json",
	"jsx",
	"log",
	"markdown",
	"md",
	"py",
	"rb",
	"rs",
	"sh",
	"sql",
	"svelte",
	"toml",
	"ts",
	"tsv",
	"tsx",
	"txt",
	"vue",
	"xml",
	"yaml",
	"yml",
]);

/** Picker `accept` for composers that stage images and readable text files. */
export const IMAGE_AND_TEXT_ACCEPT = [
	"image/*",
	...Array.from(TEXT_ATTACHMENT_EXTENSIONS, (ext) => `.${ext}`),
].join(",");

/** Cap on a text file inlined into the turn (Core truncates far beyond this). */
export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const TEXT_APPLICATION_TYPE =
	/^application\/(?:json|xml|(?:x-)?yaml|toml|sql|(?:x-)?sh|javascript|typescript)$/;

/** Whether `file` is plain text the composer can inline without a parser. */
export function isTextAttachmentFile(file: File): boolean {
	if (file.type.startsWith("text/") || TEXT_APPLICATION_TYPE.test(file.type)) {
		return true;
	}
	const extension = file.name.split(".").at(-1)?.toLowerCase();
	return Boolean(extension && TEXT_ATTACHMENT_EXTENSIONS.has(extension));
}

/** A staged image or text file; both paths always know the media type. */
export type StagedComposerFile = AttachedImage & { mimeType: string };

/** Bytes sampled from the head of a file to decide whether it is text. */
const TEXT_SNIFF_BYTES = 8192;

/**
 * Whether the head of `file` is NUL-free, valid UTF-8. A text-like extension is
 * not proof (`.ts` is also MPEG transport stream video), and `file.text()` would
 * otherwise inline binary as replacement characters. UTF-16 files (FF FE / FE FF
 * byte order mark) are refused on purpose: `file.text()` decodes as UTF-8, so
 * they would arrive garbled anyway.
 */
async function looksLikeUtf8Text(file: File): Promise<boolean> {
	const sample = new Uint8Array(
		await file.slice(0, TEXT_SNIFF_BYTES).arrayBuffer()
	);
	if (sample.includes(0)) {
		return false;
	}
	try {
		// `stream: true` so a multibyte character cut at the sample edge is not
		// counted as invalid.
		new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/** Read a text file into a staged `text/plain` attachment. */
export async function readTextAttachment(
	file: File
): Promise<StagedComposerFile> {
	if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
		throw new Error(
			`${file.name} is too large to attach (max ${MAX_TEXT_ATTACHMENT_BYTES / (1024 * 1024)} MB)`
		);
	}
	if (!(await looksLikeUtf8Text(file))) {
		throw new Error(`${file.name} doesn't look like a text file`);
	}
	const text = await file.text();
	return {
		id: nextId("txt"),
		filename: file.name,
		url: textToDataUrl(text),
		mimeType: "text/plain",
		size: file.size,
	};
}

/**
 * Stage images (unchanged path: data URL plus best-effort Uploads persist) and
 * readable text files into a composer's list. Returns the names of files neither
 * path can read, so the surface can say so instead of dropping them silently.
 */
export function stageImageAndTextFiles(
	target: ApiTarget,
	files: File[],
	add: (item: StagedComposerFile) => void,
	onError: (message: string) => void
): string[] {
	const unsupported: string[] = [];
	for (const file of files) {
		if (file.type.startsWith("image/")) {
			void stageImageUpload(target, file)
				.then(({ dataUrl, upload }) =>
					add({
						id: upload?.id ?? nextId("img"),
						filename: file.name,
						url: dataUrl,
						mimeType: file.type,
						size: file.size,
					})
				)
				.catch((err) =>
					onError(
						err instanceof Error ? err.message : `Could not read ${file.name}`
					)
				);
		} else if (isTextAttachmentFile(file)) {
			void readTextAttachment(file)
				.then(add)
				.catch((err) =>
					onError(
						err instanceof Error ? err.message : `Could not read ${file.name}`
					)
				);
		} else {
			unsupported.push(file.name);
		}
	}
	return unsupported;
}

function patch(
	update: Update,
	id: string,
	changes: Partial<ComposerAttachment>
): void {
	update((prev) =>
		prev.map((item) => (item.id === id ? { ...item, ...changes } : item))
	);
}

/**
 * Stage `files` into a composer's attachment list.
 *
 * Images take the path they always took: a `data:` URL for the model turn plus a
 * best-effort persist into the Uploads space. Unchanged, deliberately — this change
 * is about what happens to everything else.
 *
 * Everything else gets a chip IMMEDIATELY (`state: "processing"`) and is sent to
 * Core's `document.parse` facade. The chip is inserted before the parse starts so a
 * 90-second OCR is visibly happening rather than looking like the old silent drop,
 * and so the user can send their message meanwhile — the composer never waits on
 * this promise.
 *
 * Nothing is ever discarded quietly. A format no backend can read ends as
 * `state: "error"` with the reason from Core on the chip.
 */
export function stageComposerFiles(
	target: ApiTarget,
	files: File[],
	update: Update
): void {
	for (const file of files) {
		if (file.type.startsWith("image/")) {
			stageImage(target, file, update);
		} else {
			stageDocument(target, file, update);
		}
	}
}

function stageImage(target: ApiTarget, file: File, update: Update): void {
	void stageImageUpload(target, file)
		.then(({ dataUrl, upload }) => {
			update((prev) => [
				...prev,
				{
					id: upload?.id ?? nextId("img"),
					filename: file.name,
					url: dataUrl,
					mimeType: file.type,
					size: file.size,
					state: "done",
				},
			]);
		})
		.catch((err) => {
			// The Uploads persist is already best-effort inside `stageImageUpload`;
			// reaching here means the local read itself failed. Without this arm the
			// promise rejected unhandled and the image vanished with no chip — the
			// same silent drop this module exists to end, just on the image path.
			update((prev) => [
				...prev,
				{
					id: nextId("img"),
					filename: file.name,
					url: "",
					mimeType: file.type,
					size: file.size,
					state: "error",
					error:
						err instanceof Error ? err.message : "Could not read this image",
				},
			]);
		});
}

function stageDocument(target: ApiTarget, file: File, update: Update): void {
	const id = nextId("doc");
	if (file.size > MAX_PARSE_BYTES) {
		// Refused before the upload, not after: the route's body limit answers an
		// oversized POST with a bare 413 that carries no readable reason.
		update((prev) => [
			...prev,
			{
				id,
				filename: file.name,
				url: "",
				mimeType: file.type || "application/octet-stream",
				size: file.size,
				state: "error",
				error: `Too large to read (max ${Math.floor(MAX_PARSE_BYTES / (1024 * 1024))} MB)`,
			},
		]);
		return;
	}
	update((prev) => [
		...prev,
		{
			id,
			filename: file.name,
			url: "",
			mimeType: file.type || "application/octet-stream",
			size: file.size,
			state: "processing",
		},
	]);

	void parseDocument(target, file)
		.then((result) => {
			if (result.status === "succeeded" && result.markdown) {
				patch(update, id, {
					state: "done",
					// The chip keeps the ORIGINAL filename; only the payload becomes
					// markdown, which is what Core reads back off the part.
					mimeType: "text/markdown",
					url: markdownToDataUrl(result.markdown),
					error: undefined,
				});
				return;
			}
			patch(update, id, {
				state: "error",
				error:
					result.error ??
					(result.missingDependencies?.length
						? `Parser is missing ${result.missingDependencies.join(", ")}`
						: "Could not read this file"),
			});
		})
		.catch((err) => {
			patch(update, id, {
				state: "error",
				error: err instanceof Error ? err.message : "Could not read this file",
			});
		});
}

/**
 * Split the staged list into what rides this turn and what stays behind.
 *
 * A document still being read, or one that failed, is KEPT staged rather than sent
 * or dropped: the user's message goes out immediately (a large document must never
 * block sending), the chip stays visible with its live state, and the file rides the
 * next turn once it is ready. Sending a half-parsed document, or clearing a failed
 * one, would both be the silent-discard bug in a new costume.
 */
export function partitionForSend(attachments: ComposerAttachment[]) {
	const send: ComposerAttachment[] = [];
	const keep: ComposerAttachment[] = [];
	for (const item of attachments) {
		const ready = (item.state ?? "done") === "done" && item.url !== "";
		if (ready) {
			send.push(item);
		} else {
			keep.push(item);
		}
	}
	return { send, keep };
}

/** The AI-SDK `file` parts for a set of ready attachments. */
export function toSendFiles(attachments: ComposerAttachment[]): {
	filename: string;
	mediaType: string;
	type: "file";
	url: string;
}[] {
	return attachments.map((item) => ({
		type: "file" as const,
		mediaType: item.mimeType ?? "image/png",
		filename: item.filename,
		url: item.url,
	}));
}
