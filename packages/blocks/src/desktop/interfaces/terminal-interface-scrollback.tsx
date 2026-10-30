import { cn } from "@ryu/ui/lib/utils";
import type { RefObject } from "react";
import { BlockCopyButton } from "./terminal-interface-copy-button.tsx";
import type {
	TerminalAgentRow,
	TerminalCounts,
	TerminalThreadRow,
} from "./terminal-model.ts";
import {
	type TerminalAction,
	type TerminalBlock,
	TerminalEntryView,
} from "./terminal-output.tsx";

/** The scrollback: one hoverable, copyable block per command and its output. */
export function TerminalScrollback({
	agentRows,
	blocks,
	counts,
	gutter,
	loading,
	needsYou,
	now,
	runAction,
	scrollRef,
}: {
	agentRows: TerminalAgentRow[];
	blocks: TerminalBlock[];
	counts: TerminalCounts;
	gutter: string;
	loading: boolean;
	needsYou: TerminalThreadRow[];
	now: number;
	runAction: (action: TerminalAction) => void;
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			className="@container/terminal-log min-h-0 flex-1 overflow-y-auto overscroll-contain"
			ref={scrollRef}
		>
			<div
				aria-busy={loading}
				aria-label="Terminal output"
				aria-live="polite"
				className="flex flex-col"
				role="log"
			>
				{blocks.map((block) => {
					const [first, ...rest] = block.entries;
					const output = block.kind === "command" ? rest : block.entries;
					return (
						<div
							className={cn(
								"group/block relative border-border border-b py-3 last:border-b-0 focus-within:bg-muted/40 hover:bg-muted/40 motion-safe:transition-colors motion-safe:duration-100",
								gutter
							)}
							data-block={block.kind}
							key={block.id}
						>
							{block.kind === "command" && first ? (
								<TerminalEntryView
									agents={agentRows}
									counts={counts}
									entry={first}
									loading={loading}
									needsYou={needsYou}
									now={now}
									onAction={runAction}
								/>
							) : null}
							{output.length > 0 ? (
								<div className={block.kind === "command" ? "pt-2" : undefined}>
									{output.map((entry) => (
										<TerminalEntryView
											agents={agentRows}
											counts={counts}
											entry={entry}
											key={entry.id}
											loading={loading}
											needsYou={needsYou}
											now={now}
											onAction={runAction}
										/>
									))}
								</div>
							) : null}
							<BlockCopyButton block={block} needsYou={needsYou} now={now} />
						</div>
					);
				})}
			</div>
		</div>
	);
}
