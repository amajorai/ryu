// Agent-feed widget: renders the latest reply from an agent-bound source as a
// scrolling text feed with a freshness timestamp.

import { asRecord } from "./data.ts";

function resolveText(value: unknown): string {
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

export function AgentFeedBody({
	value,
	refreshedAt,
}: {
	value: unknown;
	refreshedAt?: string | null;
}) {
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
					Updated {new Date(refreshedAt).toLocaleTimeString()}
				</span>
			)}
		</div>
	);
}
