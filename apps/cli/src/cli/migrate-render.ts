// Localized pieces of the `ryu migrate` report: outcome status labels, the
// closing checklist, and display-width padding so CJK labels stay aligned.

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

/** The translator the plan and report render with (tests pass a stub). */
export type MigrateTranslator = Pick<CliTranslator, "tf" | "tr">;

/** Outcome statuses as the report shows them; unknown ones stay as sent. */
const STATUS_LABELS: Record<string, string> = {
	imported: "Imported",
	skipped: "Skipped",
	failed: "Failed",
};

export function statusLabel(
	status: string,
	t: MigrateTranslator = CLI_TRANSLATOR
): string {
	const label = STATUS_LABELS[status];
	return label ? t.tr(label) : status;
}

/** Pad to a terminal width, so CJK labels keep their columns aligned. */
export function padCell(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - Bun.stringWidth(value)))}`;
}

/** The closing checklist: a heading and four numbered sentences. */
export function nextSteps(t: MigrateTranslator = CLI_TRANSLATOR): string {
	const steps = [
		t.tr(
			"Start a new chat; imported agents, skills, and memory apply to new sessions."
		),
		t.tr(
			"Review imported MCP servers in Settings → MCP; sign in again where they use OAuth or headers."
		),
		t.tr(
			'Reconnect messaging channels and schedules listed under "Review before cutover".'
		),
		t.tr(
			"Keep the source folder until you have checked Ryu; migration copies, it never moves."
		),
	];
	const lines = steps.map((step, index) => `  ${index + 1}. ${step}`);
	return `${t.tr("Next steps:")}\n${lines.join("\n")}\n`;
}
