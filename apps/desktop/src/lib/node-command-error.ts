// Words the coded failures the node-list commands reject with
// (`src-tauri/src/nodes/error.rs`): `add_node`, `update_node_token`,
// `remove_node` and `set_default_node` send a stable `code`, the node `name` in
// `values`, and a technical `detail` for a failed save. Each code maps to one
// whole translated sentence here. The detail and any uncoded error text are
// logged, never shown as the sentence.

import type { LiteralMessage } from "@ryu/i18n/react";

export type NodeCommandErrorCode =
	| "duplicate_name"
	| "invalid_name"
	| "local_node"
	| "not_found"
	| "save_failed";

/** The wire shape: `{ code, values: { name }, detail? }`. */
export interface NodeCommandError {
	code: NodeCommandErrorCode | (string & {});
	detail?: string | null;
	values?: { name?: string } | null;
}

/**
 * The rule `add_node` enforces (`is_valid_node_name` in Rust): a non-empty run
 * of letters, digits and hyphens. Rust's `char::is_alphanumeric` is Unicode
 * `Alphabetic` or `Numeric`, which these property escapes match.
 */
const NODE_NAME = /^[\p{Alphabetic}\p{N}-]+$/u;

export function isValidNodeName(name: string): boolean {
	return NODE_NAME.test(name);
}

export function isNodeCommandError(value: unknown): value is NodeCommandError {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string"
	);
}

/** The sentence shown when a name breaks the rule, before or after invoking. */
export function invalidNodeNameSentence(tl: LiteralMessage): string {
	return tl("Use only letters, numbers, and hyphens in the name.");
}

/** The translated sentence for a known code, or `null` for an unknown one. */
export function nodeCommandErrorSentence(
	error: NodeCommandError,
	tl: LiteralMessage
): string | null {
	const name = error.values?.name ?? "";
	switch (error.code) {
		case "invalid_name":
			return invalidNodeNameSentence(tl);
		case "duplicate_name":
			return tl("{name} is already saved. Choose another name.", { name });
		case "not_found":
			return tl("{name} is no longer saved. Refresh the list and try again.", {
				name,
			});
		case "local_node":
			return tl("This computer's own node can't be removed.");
		case "save_failed":
			return tl("Ryu couldn't save the node list. Try again.");
		default:
			return null;
	}
}

/**
 * The translated sentence for a coded node-command rejection, after logging its
 * technical detail; `null` for anything uncoded (a plan-cap notice, a JS error,
 * an older build's English string), which the caller handles as before.
 */
export function nodeCommandErrorMessage(
	error: unknown,
	tl: LiteralMessage
): string | null {
	if (!isNodeCommandError(error)) {
		return null;
	}
	if (error.detail) {
		console.warn(`[nodes] ${error.code}: ${error.detail}`);
	}
	return nodeCommandErrorSentence(error, tl);
}
