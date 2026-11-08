// One entry in a "Restore version…" select.
//
// `NativeSelectOption` runs its text through the literal catalog, which would
// translate a label the user typed when it matches a catalog string. This
// option shows Core's automatic labels translated (`versionLabelText`) and a
// user label exactly as written, with the same look as `NativeSelectOption`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { versionLabelText } from "@ryu/i18n/system-version-labels";

export function VersionLabelOption({
	fallback,
	label,
	value,
}: {
	/** Shown when the version has no label, e.g. its formatted date. */
	fallback: string;
	label?: string | null;
	value: string;
}) {
	const tl = useLiteralMessages();
	return (
		<option
			className="bg-[Canvas] text-[CanvasText]"
			data-ryu-i18n="off"
			data-slot="native-select-option"
			value={value}
		>
			{label ? versionLabelText(label, tl) : fallback}
		</option>
	);
}
