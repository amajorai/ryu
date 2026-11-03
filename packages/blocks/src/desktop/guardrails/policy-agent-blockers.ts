// Why a policy cannot be assigned to an agent, in the reader's language.
//
// `agentUnsupportedFields` (policy-model.ts) answers with field ids; this file
// turns them into translated names and joins them with the locale's list
// pattern, so the "Remove {fields} first." sentence never embeds English field
// names or an English ", " join.

import { translate as tl } from "@ryu/i18n/core";
import { formatList } from "@ryu/i18n/lite";

/** A rule an agent assignment cannot carry (the API's `agent_scope_unsupported`). */
export type AgentUnsupportedField =
	| "approvedModels"
	| "approvedProviders"
	| "allowedRegions"
	| "permissions"
	| "budgets"
	| "zeroDataRetention"
	| "locked";

/** Lower-case names: they sit inside a sentence. */
const AGENT_UNSUPPORTED_FIELD_LABELS = {
	approvedModels: () => tl("approved models"),
	approvedProviders: () => tl("approved providers"),
	allowedRegions: () => tl("regions"),
	permissions: () => tl("permissions"),
	budgets: () => tl("spend cap"),
	zeroDataRetention: () => tl("zero data retention"),
	locked: () => tl("locked fields"),
} satisfies Record<AgentUnsupportedField, () => string>;

/** The translated name of one blocking field. */
export function agentUnsupportedFieldLabel(
	field: AgentUnsupportedField
): string {
	return AGENT_UNSUPPORTED_FIELD_LABELS[field]();
}

/** "approved models and spend cap" / "承認済みモデル、利用上限": the blockers as one list. */
export function agentUnsupportedFieldList(
	fields: readonly AgentUnsupportedField[],
	locale?: string
): string {
	return formatList(
		fields.map(agentUnsupportedFieldLabel),
		"conjunction",
		locale
	);
}
