import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Agent-feed widget: renders the latest reply from an agent-bound source as a
// scrolling text feed with a freshness timestamp.

import { formatTime } from "@/src/lib/timezone.ts";
import { asRecord } from "./data.ts";

function resolveText<TValue>(value: TValue): string | undefined {
	if (isNativeText(value)) {
		return value;
	}
	const record = asRecord(value);
	if (record && isNativeText(record.text)) {
		return record.text;
	}
	return value === null || value === undefined
		? ""
		: JSON.stringify(value, null, 2);
}

export function AgentFeedBody({
	value,
	refreshedAt,
}: {
	value: unknown;
	refreshedAt?: string | null;
}) {
	const tl = useLiteralMessages();
	const text = resolveText(value);
	return (
		<div className="flex h-full flex-col gap-2">
			<div className="flex-1 overflow-auto whitespace-pre-wrap text-sm leading-relaxed">
				{text || (
					<span className="text-muted-foreground">Waiting for the agent…</span>
				)}
			</div>
			{refreshedAt && (
				<span className="text-muted-foreground text-xs">
					{tl("Updated {updatedTime}", {
						updatedTime: formatTime(refreshedAt),
					})}
				</span>
			)}
		</div>
	);
}
