// apps/desktop/src/lib/api/documents.ts
//
// Client for Core's `document.parse` facade (`/api/documents/parse*`) — the only
// extraction path a CLIENT may use. Composer attachments call it through
// `lib/composer/attachments.ts`; nothing else should re-implement extraction.
//
// "Only for a client" is the precise claim. The facade also has a typed in-process
// API (`submit_blob` / `job_outcome` / `builtin_parse`), and that — not these routes
// — is what carries Space and chat uploads today: `crate::space_file_index` calls it
// directly when a file is stored. So a document reaching an index without any HTTP
// request below being made is normal, not a second extraction path.
//
// Submit → poll, never one long request: the bound provider is a lazy sidecar whose
// activity guard drops when response headers arrive, so a single long-lived parse
// request can be reaped mid-flight. Core mirrors that contract, and so does this.
//
// # Which routes here are real
//
// All three parse routes are registered in Core: `GET /api/documents/parse/capability`,
// and the submit/poll pair {@link submitParse} / {@link fetchParseJob} (and so
// {@link parseDocument}) address — `POST /api/documents/parse` and
// `GET /api/documents/parse/jobs/:job_id`. The pair's first client is the TypeScript
// SDK's document loaders; `stageComposerFiles` in `lib/composer/attachments.ts` is
// the desktop consumer. See `apps/core/src/document_parse.rs`'s module doc.
//
// There is no `/api/document-parse/*` pair, and there never was. This module used to
// document and fetch `GET /api/document-parse/backends` + `POST /api/document-parse/backend`
// as if Core served them; `grep -rn "document-parse" apps/core/src` matched a single
// doc comment. The panel that read them therefore reported "no document parser is
// enabled on this node" while markitdown was installed, enabled and bound — a fetch
// that fails is not a fact about the node. The backend view is now composed from the
// GENERIC capability layer (`./capability-layers.ts` → `/api/capabilities` and
// `/api/capabilities/bindings`), which is where every other hot-swappable layer reads
// and writes, and which is what the removed doc comment already claimed these routes
// were "a thin view of".

import { z } from "zod";
import {
	CapabilityBindingConflictError,
	type CapabilityLayer,
	type CapabilityProvider,
	clearCapabilityBinding,
	describeBindingFailure,
	fetchCapabilityLayers,
	setCapabilityBinding,
} from "./capability-layers.ts";
import {
	ApiError,
	type ApiTarget,
	authenticatedFetch,
	identityHeaders,
} from "./client.ts";
import {
	type DocumentJobWire,
	documentCapabilityWireSchema,
	documentErrorWireSchema,
	documentJobWireSchema,
} from "./document-wire-contracts.ts";

/** What this node can extract text from, right now. */
export interface ParseCapability {
	/** Whether the bound provider reports itself usable (its library imports). */
	available: boolean;
	/** Extensions Core reads with no provider at all (`.txt`, `.md`, `.csv`, …). */
	builtinExtensions: string[];
	/** Union of the builtin floor and the bound provider's claimed formats. */
	extensions: string[];
	maxInputBytes: number;
	/** Native tools the provider needs but cannot find (poppler, tesseract, …). */
	missingDependencies: string[];
	/** Bound provider's plugin id, or null when only the builtin floor is active. */
	provider: string | null;
	providerName: string | null;
}

/** A parse in progress or finished. Mirrors Core's normalized job shape. */
export interface ParseResult {
	error?: string;
	jobId?: string;
	markdown?: string;
	missingDependencies?: string[];
	/** Core preserves future provider status strings. */
	status: string;
	truncated?: boolean;
}

function headersFor(target: ApiTarget) {
	const headers = { ...identityHeaders() };
	if (target.token) {
		headers.authorization = `Bearer ${target.token}`;
	}
	return headers;
}

/** Read `error` out of a non-OK response body, falling back to the status. */
async function errorOf(res: Response): Promise<string> {
	try {
		const body = documentErrorWireSchema.parse(await res.json());
		if (body.error) {
			return body.error;
		}
	} catch {
		// Body was not JSON — fall through to the status line.
	}
	return `Request failed (${res.status})`;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function normalizeJob(wire: DocumentJobWire): ParseResult {
	const status = wire.status ?? "running";
	return {
		status,
		jobId: wire.job_id ?? undefined,
		markdown: wire.markdown ?? undefined,
		truncated: wire.truncated ?? false,
		error: wire.error ?? undefined,
		missingDependencies: wire.missing_dependencies ?? [],
	};
}

/** `GET /api/documents/parse/capability` — what the file picker should offer. */
export async function fetchParseCapability(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<ParseCapability> {
	const res = await authenticatedFetch(
		target,
		"/api/documents/parse/capability",
		{
			headers: headersFor(target),
			signal,
		}
	);
	if (!res.ok) {
		throw new Error(await errorOf(res));
	}
	const wire = documentCapabilityWireSchema.parse(await res.json());
	return {
		available: wire.available ?? true,
		builtinExtensions: wire.builtin_extensions ?? [],
		extensions: wire.extensions ?? [],
		maxInputBytes: wire.max_input_bytes ?? 0,
		missingDependencies: wire.missing_dependencies ?? [],
		provider: wire.provider ?? null,
		providerName: wire.provider_name ?? null,
	};
}

/**
 * `POST /api/documents/parse` — submit a file for extraction.
 *
 * Resolves as soon as Core answers: `succeeded` (the builtin text floor read it
 * inline) or `queued`/`running` with a `jobId` to poll. A format nothing can read
 * REJECTS with the reason, which is the whole point — it is shown on the chip.
 */
export async function submitParse(
	target: ApiTarget,
	file: File,
	signal?: AbortSignal
): Promise<ParseResult> {
	const res = await authenticatedFetch(target, "/api/documents/parse", {
		method: "POST",
		headers: {
			...headersFor(target),
			"x-filename": encodeURIComponent(file.name),
			"content-type": file.type || "application/octet-stream",
		},
		body: file,
		signal,
	});
	if (!res.ok) {
		throw new Error(await errorOf(res));
	}
	return normalizeJob(documentJobWireSchema.parse(await res.json()));
}

/** `GET /api/documents/parse/jobs/:id` — one poll. */
export async function fetchParseJob(
	target: ApiTarget,
	jobId: string,
	signal?: AbortSignal
): Promise<ParseResult> {
	const res = await authenticatedFetch(
		target,
		`/api/documents/parse/jobs/${encodeURIComponent(jobId)}`,
		{ headers: headersFor(target), signal }
	);
	if (!res.ok) {
		throw new Error(await errorOf(res));
	}
	return normalizeJob(documentJobWireSchema.parse(await res.json()));
}

/** Poll interval. Short enough to feel live, long enough not to spin the sidecar. */
const POLL_INTERVAL_MS = 900;

/**
 * How long to keep polling one parse before giving up.
 *
 * A ceiling, not a promise: a 600-page scanned PDF under OCR legitimately takes
 * minutes, and the provider enforces its own timeout. This exists so a job the
 * provider forgot about cannot leave a chip spinning for the rest of the session.
 */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Submit `file` and resolve when extraction finishes, failed or succeeded.
 *
 * Never throws for a parse that legitimately failed — that comes back as
 * `{ status: "failed", error }` so the caller can put the reason on the chip.
 * Throws only for transport/refusal, which the caller treats the same way.
 */
export async function parseDocument(
	target: ApiTarget,
	file: File,
	signal?: AbortSignal
): Promise<ParseResult> {
	const submitted = await submitParse(target, file, signal);
	if (TERMINAL_STATUSES.has(submitted.status)) {
		return submitted;
	}
	const jobId = submitted.jobId;
	if (!jobId) {
		return {
			status: "failed",
			error: "the parser accepted the file but returned no job id",
		};
	}

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let latest = submitted;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, POLL_INTERVAL_MS);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason ?? new Error("aborted"));
				},
				{ once: true }
			);
		});
		latest = await fetchParseJob(target, jobId, signal);
		if (TERMINAL_STATUSES.has(latest.status)) {
			return latest;
		}
	}
	return {
		status: "failed",
		error: "the parser did not finish in time",
		jobId,
	};
}

// ── Which backend extracts text (`document.parse` binding) ─────────────────────
//
// The extractor is a CAPABILITY, not a Rust trait: several apps can provide
// `document.parse` at once and Core resolves one with
// `user override > sole provider > declared default > lowest id`. So the backend
// view is one row of the GENERIC capability read model, not a private endpoint:
// this section is a `document.parse` filter over `./capability-layers.ts`, which
// owns the transport, the typed 409, and the read-merge-write that keeps a
// single-layer change from wiping every other layer's override.
//
// Deliberately OUTSIDE the Spaces AppGate: the bound provider serves chat
// attachments too, so a node with Spaces turned off must still be able to see and
// pick a backend. Nothing here wakes a sidecar — this is pure metadata, safe to
// call on a settings mount.

/** The capability name. One string, mirroring Core's `CAP_DOCUMENT_PARSE`. */
export const DOCUMENT_PARSE_CAPABILITY = "document.parse";

/** One `document.parse` provider app. */
export interface ParseBackend {
	/** The manifest id (`@ryu/markitdown`) — the value an override stores. */
	id: string;
	/** Whether it declares itself the default pick. */
	isDefault: boolean;
	name: string;
	version: string;
}

/** The installed backends and the bound one — `/api/capabilities`, filtered. */
export interface ParseBackendList {
	/** Installed but NOT enabled. Rendered as "enable it", never hidden: every
	 *  heavy backend ships opt-in, so hiding these leaves a node looking as if
	 *  nothing could ever read a PDF. */
	available: ParseBackend[];
	/** The provider serving parses right now, or null when only the floor is. */
	bound: string | null;
	/** True when the binding comes from an explicit override, not the auto-pick. */
	overridden: boolean;
	/** Every ENABLED candidate. */
	providers: ParseBackend[];
	/** Whether a pick is offered at all. False (with 2+ providers) means the
	 *  capability does not resolve and a picker would be a lie. */
	selectable: boolean;
}

/**
 * A capability-layer provider narrowed to what a parser picker renders.
 *
 * `servesVerbs` / `target` are dropped on purpose rather than passed through:
 * `document.parse` has no facade verbs (Core calls the provider's HTTP sidecar
 * directly, see `document_parse.rs`) and no machine target, so surfacing either
 * here would put a permanently-false qualifier on every row.
 */
function toBackend(p: CapabilityProvider): ParseBackend {
	return {
		id: p.id,
		isDefault: p.isDefault,
		name: p.name,
		version: p.version,
	};
}

/** The `document.parse` layer as this module's shape, or the empty view. */
function toBackendList(layer: CapabilityLayer | undefined): ParseBackendList {
	return {
		available: (layer?.available ?? []).map(toBackend),
		bound: layer?.bound ?? null,
		overridden: layer?.overridden ?? false,
		providers: (layer?.providers ?? []).map(toBackend),
		selectable: layer?.selectable ?? false,
	};
}

/**
 * The `document.parse` row of `GET /api/capabilities`.
 *
 * A node with no parsing app at all returns no such row, which is why the miss is
 * an EMPTY view rather than a throw: "nothing provides this yet" is a state the
 * panel renders (with the built-in floor and a pointer at the Store), not an error.
 * A transport failure still throws — the caller must be able to tell "this node has
 * no parser" from "this node did not answer", because rendering the second as the
 * first is the exact misreport this function was written to end.
 */
// No UI caller since the Gateway's "Document parsing" section was retired: the
// node dropdown's Toolkits row binds `document.parse` through the same
// `./capability-layers.ts` seam this wraps, generically, like every other
// swappable capability. Kept as the typed, tested `document.parse` view of that
// seam — a caller that wants the parse layer by name should use this rather than
// re-deriving it from the raw capability model.
export async function fetchParseBackends(
	target: ApiTarget
): Promise<ParseBackendList> {
	const model = await fetchCapabilityLayers(target);
	return toBackendList(
		model.capabilities.find((c) => c.capability === DOCUMENT_PARSE_CAPABILITY)
	);
}

/**
 * Pick the backend, or pass `null` to clear the override and fall back to Core's
 * automatic pick.
 *
 * Both halves go through `./capability-layers.ts` so the write is merged into the
 * existing override map and serialized against every other layer's write: the
 * endpoint REPLACES the map, and a `document.parse`-only PUT would silently reset
 * the node's `web.search`, `memory` and `computer.control` picks.
 *
 * Documents already parsed by the previous backend KEEP their old text: swapping
 * does not silently re-extract a node's history. Re-parsing is the deliberate
 * second step (`reparseSpace` / `reparseDocument` in `./spaces.ts`).
 *
 * Throws `CapabilityBindingConflictError` on Core's 409 — see
 * {@link describeApiRefusal}, which renders it with the blocking plugin intact.
 */
export async function setParseBackend(
	target: ApiTarget,
	backendId: string | null
): Promise<void> {
	if (backendId === null) {
		await clearCapabilityBinding(target, DOCUMENT_PARSE_CAPABILITY);
		return;
	}
	await setCapabilityBinding(target, DOCUMENT_PARSE_CAPABILITY, backendId);
}

/**
 * The reason a Core call was refused, in a form that keeps the parts that say
 * WHAT broke.
 *
 * Three error shapes reach this one toast, and the flattest handling loses the
 * useful field in two of them:
 *
 * - `CapabilityBindingConflictError` — Core's 409 on a refused binding change,
 *   carrying the enabled `plugin` the change would leave unbound and the stable
 *   `binding_error` code. Delegated to `describeBindingFailure` so a refusal is
 *   worded identically here and in the node layer menu; `error.message` alone
 *   would drop both fields.
 * - `ApiError` — a generic Core refusal whose body has `{error}`. Its own
 *   `.message` is the opaque `"<path> failed: <status>"`, so the server message
 *   wins.
 * - anything else — transport. Its message is all there is.
 *
 * The opaque-failure class this whole feature exists to end is exactly what a
 * bare `String(error)` would reproduce in the feature's own error path.
 */
const nativeErrorSchema = z.instanceof(Error);

export function describeApiRefusal(
	error: Parameters<typeof nativeErrorSchema.parse>[0]
): string | undefined {
	if (error instanceof CapabilityBindingConflictError) {
		return describeBindingFailure(error, "this parser");
	}
	if (error instanceof ApiError) {
		return error.serverMessage ?? error.message;
	}
	const nativeError = nativeErrorSchema.safeParse(error);
	return nativeError.success ? nativeError.data.message : undefined;
}

/**
 * Turn a stored `parse_error` (`"<code>: <message>"`) into a sentence that says
 * what to DO.
 *
 * The codes come from `ParseFailureReason::code()` in
 * `apps/core/src/document_parse.rs`, and the prefix is the point: `no_provider`
 * and `python_missing` are not "this file has no text", they are "this node
 * cannot read it yet, and here is what is missing". Rendering either as a bare
 * red dot recreates the exact bug the whole feature exists to kill.
 */
export function describeParseFailure(raw: string | null | undefined): string {
	if (!raw) {
		return "Extraction produced no text.";
	}
	const separator = raw.indexOf(":");
	const code = separator > 0 ? raw.slice(0, separator) : "";
	const detail = (separator > 0 ? raw.slice(separator + 1) : raw).trim();
	switch (code) {
		case "python_missing":
			return "Python not found on this node — using built-in text-only parsing. Install Python 3, then re-parse.";
		case "no_provider":
			return "No document parser is installed. Get one from the Store, then re-parse.";
		case "unsupported_format":
			return `Nothing on this node reads this format. ${detail}`.trim();
		case "provider_timeout":
			return "The parser ran out of time on this file. Try again.";
		case "too_large":
			return `Too large to read. ${detail}`.trim();
		case "provider_error":
			return detail || "The parser failed on this file.";
		default:
			return detail || raw;
	}
}

/** True when a stored `parse_error` means the HOST has no Python interpreter —
 *  the one failure that is about the machine, not the file, and so belongs in a
 *  space-level notice rather than only on one row. */
export function isPythonMissingFailure(
	raw: string | null | undefined
): boolean {
	return raw?.startsWith("python_missing:") ?? false;
}

/** Display label for a `parse_backend_id`. `"builtin"` is Core's own text floor,
 *  not an app, and saying so is what makes the swappable layer legible. */
export function parseBackendLabel(
	backendId: string | null | undefined,
	backends: ParseBackendList | null
): string | null {
	if (!backendId) {
		return null;
	}
	if (backendId === "builtin") {
		return "built-in";
	}
	const all = backends ? [...backends.providers, ...backends.available] : [];
	return all.find((b) => b.id === backendId)?.name ?? backendId;
}
