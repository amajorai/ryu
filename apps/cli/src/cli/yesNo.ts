// A yes/no table cell in the CLI's language. Tables are human output; `--json`
// carries the boolean itself.

import { CLI_TRANSLATOR, type CliTranslator } from "../i18n/translate.ts";

/** `yes` or `no`, translated. */
export function yesNo(
	value: boolean,
	translator: Pick<CliTranslator, "tr"> = CLI_TRANSLATOR
): string {
	const { tr } = translator;
	return value ? tr("yes") : tr("no");
}
