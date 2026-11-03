// The localizable form of Ryu's own in-chat permission prompts.
//
// When one of Ryu's agents asks before it switches the interface, changes a Ryu
// setting, runs a gated tool or reconfigures itself, Core sends `toolCall.i18n`
// beside the English `fields.title` (apps/core/src/sidecar/adapters/mcp_bridge/
// permissions.rs): `title` is a whole-sentence Core message
// `{ message: <English ICU source>, args }`, `options` maps each `optionId` to
// its label message, and `detail` is untranslated technical text (an endpoint).
// The sources are catalog keys, so `tl` renders them like any other literal.
// A third-party agent's prompt, or one from an older Core, carries no `i18n`
// and keeps its agent-supplied title and option names.

/** Render an English ICU source with values in the active locale. */
export type PermissionTranslate = (
	source: string,
	values?: Record<string, string | number>
) => string;

export interface PermissionI18n {
	detail: string | null;
	optionLabels: Map<string, string>;
	title: string;
}

const MAX_SOURCE_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function renderCoreMessage(
	wire: unknown,
	tl: PermissionTranslate
): string | null {
	if (!isRecord(wire)) {
		return null;
	}
	const source = wire.message;
	if (
		typeof source !== "string" ||
		source === "" ||
		source.length > MAX_SOURCE_LENGTH
	) {
		return null;
	}
	const args = wire.args ?? {};
	if (!isRecord(args)) {
		return null;
	}
	const values: Record<string, string | number> = {};
	for (const [name, raw] of Object.entries(args)) {
		if (typeof raw === "string") {
			values[name] = raw;
		} else if (typeof raw === "number" && Number.isFinite(raw)) {
			values[name] = raw;
		} else {
			return null;
		}
	}
	return tl(source, values);
}

/** The prompt's localized title, choice labels and detail, or `null`. */
export function readPermissionI18n(
	toolCall: unknown,
	tl: PermissionTranslate
): PermissionI18n | null {
	if (!isRecord(toolCall)) {
		return null;
	}
	const i18n = toolCall.i18n;
	if (!isRecord(i18n)) {
		return null;
	}
	const title = renderCoreMessage(i18n.title, tl);
	if (title === null) {
		return null;
	}
	const optionLabels = new Map<string, string>();
	if (isRecord(i18n.options)) {
		for (const [optionId, wire] of Object.entries(i18n.options)) {
			const label = renderCoreMessage(wire, tl);
			if (label !== null) {
				optionLabels.set(optionId, label);
			}
		}
	}
	const detail =
		typeof i18n.detail === "string" && i18n.detail.trim()
			? i18n.detail.trim()
			: null;
	return { detail, optionLabels, title };
}
