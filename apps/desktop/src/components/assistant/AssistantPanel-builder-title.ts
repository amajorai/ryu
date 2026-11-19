import type { LiteralMessage } from "@ryu/i18n/react";

/**
 * The builder panel's title. An app-defined surface names itself (`label`);
 * the built-in builders say "Build <target>", with a whole sentence for each
 * unnamed target so nothing English is inserted into a translated one.
 */
export function builderPanelTitle(
	builder: { kind: string; label?: string; targetName: string },
	tl: LiteralMessage
): string {
	const label = builder.label?.trim();
	if (label) {
		return label;
	}
	const name = builder.targetName.trim();
	if (name) {
		return tl("Build {name}", { name });
	}
	if (builder.kind === "agent") {
		return tl("Build this agent");
	}
	return builder.kind === "workflow"
		? tl("Build this workflow")
		: tl("Build this");
}
