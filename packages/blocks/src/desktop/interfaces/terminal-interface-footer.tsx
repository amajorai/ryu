import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { TerminalCounts } from "./terminal-model.ts";

/** Footer key hints; esc is shown only while a thread is open. */
const KEY_HINTS: readonly {
	keys: string;
	label: (tl: LiteralMessage) => string;
}[] = [
	{ keys: "↑↓", label: (tl) => tl("history") },
	{ keys: "tab", label: (tl) => tl("complete") },
	{ keys: "ctrl-l", label: (tl) => tl("clear") },
	{ keys: "esc", label: (tl) => tl("close") },
];

/** The status line: cwd, live counts, and the key hints. */
export function TerminalFooter({
	counts,
	cwd,
	loading,
	threadOpen,
}: {
	counts: TerminalCounts;
	cwd: string;
	loading: boolean;
	threadOpen: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<footer
			aria-label="Terminal status"
			className={cn(
				"flex h-7 shrink-0 items-center gap-4 border-border border-t bg-muted/50 @3xl/terminal:pe-6 pe-4 text-muted-foreground text-xs"
			)}
		>
			<p className="flex h-full shrink-0 items-center gap-2 bg-foreground px-3 font-medium text-background">
				ryu
			</p>
			<p className="@md/terminal:flex hidden h-full shrink-0 items-center border-border border-e pe-4 text-foreground">
				{cwd}
			</p>
			{loading ? (
				<p>loading…</p>
			) : (
				<p className="flex min-w-0 items-center gap-2 whitespace-nowrap">
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							counts.working > 0
								? "bg-success motion-safe:animate-pulse"
								: "bg-muted-foreground/40"
						)}
					/>
					<span className="min-w-0 truncate">
						{tl("{working} working · {needsYou} need you", {
							needsYou: String(counts.needsYou),
							working: String(counts.working),
						})}
						{counts.attention > 0 ? (
							<>
								{" · "}
								<span className="text-destructive">
									{tl("{attention} attention", {
										attention: String(counts.attention),
									})}
								</span>
							</>
						) : null}
					</span>
				</p>
			)}
			<p className="ms-auto @3xl/terminal:flex hidden shrink-0 gap-4 whitespace-nowrap">
				{KEY_HINTS.filter((hint) => threadOpen || hint.keys !== "esc").map(
					(hint) => (
						<span key={hint.keys}>
							<span className="text-foreground" data-ryu-i18n="off">
								{hint.keys}
							</span>{" "}
							{hint.label(tl)}
						</span>
					)
				)}
			</p>
		</footer>
	);
}
