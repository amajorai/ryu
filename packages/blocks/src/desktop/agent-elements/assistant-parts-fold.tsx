import { Bubble } from "@ryu/ui/components/bubble";
import type React from "react";

export function foldAssistantProse(
	elems: { isText: boolean; node: React.ReactNode }[],
	msgId: string
): React.ReactNode[] {
	// Fold contiguous prose into ONE `Bubble` per run. A reply that reads
	// "sentence · tool call · sentence" therefore gets two bubbles with the
	// tool row between them, which is what actually happened, rather than one
	// bubble swallowing the tool row or three unrelated boxes.
	//
	// `ghost` — no fill, no padding, no radius. The agent's reply is plain prose
	// on the page; only the user's own turn is a (muted) bubble, see
	// `user-message.tsx`. `max-w-full` overrides the primitive's `max-w-[80%]`,
	// which would squeeze code, tables and diffs.
	const folded: React.ReactNode[] = [];
	let run: React.ReactNode[] = [];
	const flushRun = () => {
		if (run.length === 0) {
			return;
		}
		folded.push(
			<Bubble
				align="start"
				className="max-w-full"
				key={`${msgId}-bubble-${folded.length}`}
				variant="ghost"
			>
				{run}
			</Bubble>
		);
		run = [];
	};
	for (const entry of elems) {
		if (entry.isText) {
			run.push(entry.node);
			continue;
		}
		flushRun();
		folded.push(entry.node);
	}
	flushRun();
	return folded;
}
