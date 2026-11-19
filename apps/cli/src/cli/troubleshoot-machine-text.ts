// The Machine section of `ryu-cli troubleshoot` in the CLI's language. The
// report (`--json`, the saved Markdown, the issue body) keeps English labels
// and values; only the human output translates them, label by label. Names
// such as the profile, paths and the shell are data and stay as they are.

import type { CliTranslator } from "../i18n/translate.ts";

type MachineTranslator = Pick<CliTranslator, "tr" | "trMessage">;

/**
 * A machine row's label for people. RAM reads "Memory (RAM)": the bare
 * "Memory" key is Ryu's AI memory feature in every catalog. OS, CPU and CLI
 * are acronyms and stay.
 */
export function machineLabel(
	label: string,
	{ tr }: Pick<CliTranslator, "tr">
): string {
	switch (label) {
		case "Memory":
			return tr("Memory (RAM)");
		case "Profile":
			return tr("Profile");
		case "Core URL":
			return tr("Core URL");
		case "Data dir":
			return tr("Data dir");
		case "Shell":
			return tr("Shell");
		case "Terminal":
			return tr("Terminal");
		case "Proxy":
			return tr("Proxy");
		default:
			return label;
	}
}

/** A machine row's value for people: only built sentences translate. */
export function machineValue(
	label: string,
	value: string,
	translator: MachineTranslator
): string {
	return label === "Memory" || label === "CLI" || label === "Proxy"
		? translator.trMessage(value)
		: value;
}
