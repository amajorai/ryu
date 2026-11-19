// The copy of a transcript tool row. The vendored `components/ui/tool-call.tsx`
// sits outside the CLI's extraction root, so its words are translated here and
// passed in as the host-owned `labels` prop.

import type { ToolCallLabels } from "@/components/ui/tool-call.tsx";
import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

/** The tool row's outcome suffixes and section headings in the CLI locale. */
export function toolCallLabels(
	translator: Pick<CliTranslator, "tr"> = CLI_TRANSLATOR
): ToolCallLabels {
	const { tr } = translator;
	return {
		args: tr("Args:"),
		awaitingPermission: tr("awaiting permission"),
		denied: tr("denied"),
		interrupted: tr("interrupted"),
		result: tr("Result:"),
	};
}
