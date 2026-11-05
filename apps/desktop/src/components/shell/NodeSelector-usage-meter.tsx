// The hardware panel's RAM and disk usage: a bar plus the share in the
// viewer's number format ("42%", "42 %", Arabic digits under ar).

import { activeLocale } from "@ryu/i18n/core";
import { formatPercent } from "@ryu/i18n/format-percent";
import { Progress } from "@ryu/ui/components/progress.tsx";

export function UsageMeter({
	locale = activeLocale(),
	percent,
}: {
	locale?: string;
	/** 0-100. */
	percent: number;
}) {
	return (
		<div className="flex items-center gap-2">
			<Progress className="h-1.5 w-20" value={percent} />
			<span className="tabular-nums">
				{formatPercent(percent / 100, 0, locale)}
			</span>
		</div>
	);
}
