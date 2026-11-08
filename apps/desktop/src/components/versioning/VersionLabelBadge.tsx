// The label badge on one version-history row.
//
// Core labels its automatic checkpoints in English ("Agent saved", "Before
// restore", "Document imported"); those render translated. A label the user
// typed on a snapshot renders exactly as written, and `data-ryu-i18n="off"`
// keeps the DOM localizer from rewriting it when it matches a catalog string.

import { useLiteralMessages } from "@ryu/i18n/react";
import { versionLabelText } from "@ryu/i18n/system-version-labels";
import { Badge } from "@ryu/ui/components/badge.tsx";

export function VersionLabelBadge({ label }: { label: string }) {
	const tl = useLiteralMessages();
	return (
		<Badge data-ryu-i18n="off" size="compact" variant="secondary">
			{versionLabelText(label, tl)}
		</Badge>
	);
}
