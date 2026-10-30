// apps/desktop/src/lib/api/spaces-upload-limits.ts
//
// Upload ceilings mirrored from Core, and the byte formatter that prints them. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

/**
 * The ceiling **every upload from this app actually hits**, in bytes.
 *
 * Mirrors `MAX_UPLOAD_BYTES` in `apps/core/src/server/uploads.rs` (= `MAX_MEDIA_BYTES`,
 * 32 MiB). Chat attachments, editor pastes and the plugin host's `ui.uploadFile` all
 * `POST /api/uploads`, so this — not {@link SPACE_UPLOAD_MAX_BYTES} — is the number a
 * limits panel may print, and it is the one the node will keep. `/api/uploads` layers
 * the limit explicitly on the route, which is what makes the handler's own check the
 * one that answers (pinned by `a_route_without_an_explicit_limit_caps_at_axums_default`
 * in `uploads.rs`).
 *
 * Equal to `MAX_PARSE_BYTES` in `src/lib/composer/attachments.ts` by construction, not
 * by coincidence: Core defines `document_parse::MAX_PARSE_BYTES = MAX_UPLOAD_BYTES` so
 * "a file the user could attach is a file the parser will look at".
 */
export const NODE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The ceiling `POST /api/spaces/:id/files` declares **and now reaches** — 32 MiB.
 *
 * Mirrors `MAX_FILE_BYTES` in `apps/core/src/server/mod.rs`, which is *defined as*
 * `uploads::MAX_UPLOAD_BYTES` rather than a second literal, so the two cannot drift.
 * Pinned to the Rust in `spaces.test.ts`.
 *
 * ## It used to be 200 MiB, and that was three wrong numbers at once
 *
 * 1. The panel printed 200 MB as "Maximum file in a Space", so a 100 MB PDF was
 *    refused by a node that had just said it would take it.
 * 2. Every upload this app performs goes to `/api/uploads` and stopped at
 *    {@link NODE_UPLOAD_MAX_BYTES} — 32 MiB.
 * 3. The route could not honour 200 MiB anyway: registered with no `DefaultBodyLimit`,
 *    axum's implicit 2 MiB body limit rejected the request before the handler's check
 *    could run — and the body is base64, so the real ceiling was **~1.5 MiB of file**,
 *    roughly 133x below what was advertised. Proved, not inferred, by
 *    `a_route_without_an_explicit_limit_caps_at_axums_default` and
 *    `the_unlayered_json_route_capped_at_just_under_1_5_mib_of_file` in
 *    `apps/core/src/server/uploads.rs`.
 *
 * Core now layers `SPACE_FILE_BODY_LIMIT` on the route so the handler's check is the
 * one that answers, and the declared ceiling equals the enforced one. Raising this
 * means raising all three together — the constant, the body limit, and whatever the
 * limits panel prints — or the discrepancy comes back in a new place.
 *
 * Equal to {@link NODE_UPLOAD_MAX_BYTES} by construction. Kept as a distinct export
 * because the two describe different routes, and a future divergence should be a
 * deliberate edit here rather than a silent alias.
 */
export const SPACE_UPLOAD_MAX_BYTES = NODE_UPLOAD_MAX_BYTES;

/** Byte counts as a person reads them (`200 MB`, `1.5 GB`). Binary units, one
 *  decimal only where it carries information. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
}
