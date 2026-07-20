// Text widget: static or source-fed text/markdown. Rendered as readable prose;
// kept deliberately plain (no HTML injection) so it stays consistent and safe.

import { asRecord } from "./data.ts";
import { parseConfig, textConfigSchema } from "./schema.ts";

/** Pull display text from config.markdown, a string value, or a {text} value. */
function resolveText(value: unknown, config: unknown): string {
	const cfg = parseConfig(textConfigSchema, config);
	if (typeof cfg.markdown === "string" && cfg.markdown.length > 0) {
		return cfg.markdown;
	}
	if (typeof value === "string") {
		return value;
	}
	const record = asRecord(value);
	if (record && typeof record.text === "string") {
		return record.text;
	}
	return value === null || value === undefined
		? ""
		: JSON.stringify(value, null, 2);
}

export function TextBody({
	value,
	config,
}: {
	value: unknown;
	config: unknown;
}) {
	const text = resolveText(value, config);
	if (!text) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				No content
			</div>
		);
	}
	return (
		<div className="h-full overflow-auto whitespace-pre-wrap text-sm leading-relaxed">
			{text}
		</div>
	);
}
