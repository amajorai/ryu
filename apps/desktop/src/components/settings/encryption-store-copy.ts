// Localized copy for the Encryption tab's per-store rows.
//
// Core's `GET /api/encryption/status` sends each store's stable `id`, its
// status and the runtime values its explanation depends on (`reason`,
// `unreadableCount`, `partialReasons`), plus an English `label`/`detail` kept
// for older clients. The tab renders the copy below, keyed by id, so the
// reader sees it in their language. A store id this build does not know, or a
// partial row from an older Core that sends no values, keeps Core's English.

import type { LiteralMessage } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import type { StoreCoverage } from "@/src/lib/api/encryption.ts";

/** Why the Spaces store is only partly sealed, as Core reports it. */
export type SpacesPartialReason =
	| { code: "key-not-held" }
	| { code: "unreadable-values"; count: number }
	| { code: "sealing-running"; state: string }
	| {
			code: "files-unsealed";
			pending: string | null;
			sealed: number;
			total: number;
	  };

/** A store row plus the runtime values newer Cores send beside the English. */
type StoreRow = StoreCoverage & {
	partialReasons?: readonly SpacesPartialReason[];
	reason?: string | null;
	unreadableCount?: number;
};

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One Spaces reason from the wire, or null when this build cannot read it. */
function readSpacesReason(raw: unknown): SpacesPartialReason | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	switch (value.code) {
		case "key-not-held":
			return { code: "key-not-held" };
		case "unreadable-values":
			return isCount(value.count)
				? { code: "unreadable-values", count: value.count }
				: null;
		case "sealing-running":
			return typeof value.state === "string"
				? { code: "sealing-running", state: value.state }
				: null;
		case "files-unsealed":
			return isCount(value.sealed) && isCount(value.total)
				? {
						code: "files-unsealed",
						pending: typeof value.pending === "string" ? value.pending : null,
						sealed: value.sealed,
						total: value.total,
					}
				: null;
		default:
			return null;
	}
}

/**
 * The values beside a row's English text. The status schema passes them
 * through unchecked, so each is narrowed here; a missing or unreadable value
 * is left undefined and the row keeps Core's English detail.
 */
function readStoreRow(store: StoreCoverage): StoreRow {
	const raw = store as StoreCoverage & Record<string, unknown>;
	const row: StoreRow = { ...store };
	row.reason = typeof raw.reason === "string" ? raw.reason : undefined;
	row.unreadableCount = isCount(raw.unreadableCount)
		? raw.unreadableCount
		: undefined;
	if (Array.isArray(raw.partialReasons)) {
		const reasons = raw.partialReasons.map(readSpacesReason);
		row.partialReasons = reasons.every((reason) => reason !== null)
			? (reasons as SpacesPartialReason[])
			: undefined;
	} else {
		row.partialReasons = undefined;
	}
	return row;
}

/** What the tab shows for one store: its name, explanation and any notes. */
export interface StoreRowCopy {
	detail: string;
	label: string;
	/** Extra whole sentences (why a sealed store is only partly sealed). */
	notes: string[];
}

interface StoreCopyEntry {
	detail: (store: StoreRow, tl: LiteralMessage) => string | null;
	label: (tl: LiteralMessage) => string;
	notes?: (store: StoreRow, tl: LiteralMessage) => string[] | null;
}

function unreadableRowsNote(
	store: StoreRow,
	tl: LiteralMessage
): string[] | null {
	const count = store.unreadableCount;
	if (count === undefined) {
		return store.status === "sealed" ? [] : null;
	}
	if (count === 0) {
		return [];
	}
	return [
		tl(
			"{count, plural, one {{countText} row did not open under the current key and is skipped.} other {{countText} rows did not open under the current key and are skipped.}}",
			{ count, countText: formatNumber(count) }
		),
	];
}

function spacesReasonNote(
	reason: SpacesPartialReason,
	tl: LiteralMessage
): string {
	switch (reason.code) {
		case "key-not-held":
			return tl(
				"Not complete yet: the store is sealed under a key this process does not hold, so writes are refused."
			);
		case "unreadable-values":
			return tl(
				"{count, plural, one {Not complete yet: {countText} value did not open and is skipped.} other {Not complete yet: {countText} values did not open and are skipped.}}",
				{ count: reason.count, countText: formatNumber(reason.count) }
			);
		case "sealing-running":
			return tl("Not complete yet: sealing is still running ({state}).", {
				state: reason.state,
			});
		case "files-unsealed":
			return reason.pending
				? tl(
						"Not complete yet: {sealed} of {total} uploaded files are sealed ({reason}).",
						{
							reason: reason.pending,
							sealed: formatNumber(reason.sealed),
							total: formatNumber(reason.total),
						}
					)
				: tl(
						"Not complete yet: {sealed} of {total} uploaded files are sealed.",
						{
							sealed: formatNumber(reason.sealed),
							total: formatNumber(reason.total),
						}
					);
		default:
			return "";
	}
}

function spacesNotes(store: StoreRow, tl: LiteralMessage): string[] | null {
	if (store.partialReasons === undefined) {
		return store.status === "sealed" ? [] : null;
	}
	return store.partialReasons.map((reason) => spacesReasonNote(reason, tl));
}

function sourceHistoryDetail(
	store: StoreRow,
	tl: LiteralMessage
): string | null {
	if (store.status === "sealed") {
		return tl(
			"Saved versions of agents, workflows, skills and Space sources are sealed with the master key; paths and timestamps stay readable so the history can be listed."
		);
	}
	if (!store.reason) {
		return null;
	}
	return tl(
		"Saved versions of agents, workflows, skills and Space sources are still in the unencrypted history an earlier version kept ({reason}). Ryu retries the import at each start.",
		{ reason: store.reason }
	);
}

/** Copy for every store id Core reports; see `apps/core/src/server/encryption/stores.rs`. */
export const ENCRYPTION_STORE_COPY: Record<string, StoreCopyEntry> = {
	chats: {
		label: (tl) => tl("Chats"),
		detail: (_store, tl) =>
			tl(
				"Message bodies, streamed parts and conversation titles are sealed with the master key. Roles, ids and timestamps stay readable so lists and ordering keep working."
			),
	},
	memory: {
		label: (tl) => tl("Long-term memory"),
		detail: (_store, tl) =>
			tl(
				"Every entry's content is stored as ciphertext; only its category, tags and scope stay readable so recall can filter."
			),
	},
	identities: {
		label: (tl) => tl("Identity vault"),
		detail: (_store, tl) =>
			tl(
				"Saved website credentials are sealed before they touch the row and are never logged."
			),
	},
	"plugin-secrets": {
		label: (tl) => tl("Plugin secrets"),
		detail: (_store, tl) =>
			tl(
				"Per-plugin API keys are write-only and sealed at rest. Without a loadable master key the store refuses writes rather than storing plaintext."
			),
	},
	preferences: {
		label: (tl) => tl("Preferences & provider keys"),
		detail: (_store, tl) =>
			tl(
				"Credential preferences (provider keys, tokens and passwords) are sealed with the master key; ordinary settings remain plaintext so they stay queryable."
			),
	},
	"app-data": {
		label: (tl) => tl("App data"),
		detail: (_store, tl) =>
			tl(
				'Values apps store on this device are written as given. An app that requests the "encrypt its own data" permission seals them first, under a key derived per app that the app itself never sees; apps that do not are stored in the clear.'
			),
	},
	"device-token": {
		label: (tl) => tl("Device token"),
		detail: (_store, tl) =>
			tl(
				"The Core sign-in token and multi-account bearer tokens are sealed before auth.json or accounts.json; the separate early-boot node-auth.token remains plaintext until its boot-order path is redesigned."
			),
	},
	spaces: {
		label: (tl) => tl("Spaces & documents"),
		detail: (_store, tl) =>
			tl(
				"Document and chunk text, embeddings, page history and uploaded files are sealed with the master key. Ids, timestamps and keyed lookup tokens stay readable so access filters, title lookups and keyword search keep working."
			),
		notes: spacesNotes,
	},
	approvals: {
		label: (tl) => tl("Approvals"),
		detail: (_store, tl) =>
			tl(
				"Approval requests (tool arguments, prompts, messages, results and notes) are sealed per row; ids, status and timestamps stay readable so the inbox can filter and expire."
			),
		notes: unreadableRowsNote,
	},
	"safe-actions": {
		label: (tl) => tl("Safe actions"),
		detail: (_store, tl) =>
			tl(
				"Submitted plans with their tool arguments, verification reports and review notes are sealed per row; ids, status, policies and timestamps stay readable."
			),
		notes: unreadableRowsNote,
	},
	"prompt-evals": {
		label: (tl) => tl("Prompt evals"),
		detail: (_store, tl) =>
			tl(
				"Suite and version configs, run requests and results, and review comments are sealed per value; names, scores and timestamps stay readable."
			),
		notes: unreadableRowsNote,
	},
	agents: {
		label: (tl) => tl("Agents"),
		detail: (_store, tl) =>
			tl(
				"Agent descriptions, system prompts, personas and saved prompt versions are sealed per value; ids, names, tool and model bindings stay readable so agents can be listed and routed."
			),
		notes: unreadableRowsNote,
	},
	workflows: {
		label: (tl) => tl("Workflows & routines"),
		detail: (_store, tl) =>
			tl(
				"Webhook secrets, chat bot tokens and webhook URLs inside saved workflows, scripts and scheduled routines are sealed per value; the rest of each definition stays readable so it can run."
			),
		notes: unreadableRowsNote,
	},
	"alert-delivery": {
		label: (tl) => tl("Alert delivery targets"),
		detail: (_store, tl) =>
			tl(
				"Telegram bot tokens, Slack and Discord webhook URLs, push tokens and email recipients that alerts are sent to are sealed; the notification inbox itself stays readable."
			),
		notes: unreadableRowsNote,
	},
	"catalog-sources": {
		label: (tl) => tl("Marketplace sources"),
		detail: (_store, tl) =>
			tl(
				"Credentials for private marketplace sources are sealed per value; source names and URLs stay readable."
			),
		notes: unreadableRowsNote,
	},
	"gateway-audit": {
		label: (tl) => tl("Gateway audit log"),
		detail: (_store, tl) =>
			tl(
				"Request metadata stays readable; API keys are represented on disk by a SHA-256 lookup key and a short display prefix, never by the raw credential."
			),
	},
	"source-history": {
		label: (tl) => tl("Version history"),
		detail: sourceHistoryDetail,
	},
};

/** The localized label, explanation and notes for one store row. */
export function storeRowCopy(
	coverage: StoreCoverage,
	tl: LiteralMessage
): StoreRowCopy {
	const store = readStoreRow(coverage);
	const entry = Object.hasOwn(ENCRYPTION_STORE_COPY, store.id)
		? ENCRYPTION_STORE_COPY[store.id]
		: undefined;
	if (!entry) {
		return { detail: store.detail, label: store.label, notes: [] };
	}
	const detail = entry.detail(store, tl);
	const notes = entry.notes ? entry.notes(store, tl) : [];
	// An older Core sends no values for a partial row: its English detail is
	// the only text that still names why.
	if (detail === null || notes === null) {
		return { detail: store.detail, label: entry.label(tl), notes: [] };
	}
	return { detail, label: entry.label(tl), notes };
}
