import { useLiteralMessages } from "@ryu/i18n/react";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import type { KeyboardEvent } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type RecordsRow,
	recordsBoard,
	recordsFullTime,
	recordsPlural,
	recordsRelativeTime,
} from "./records-model.ts";
import { RecordsFaces, RecordsMark } from "./records-parts.tsx";

function BoardCard({
	isCursor,
	now,
	onFocus,
	onKeyDown,
	onOpen,
	registerRow,
	row,
}: {
	isCursor: boolean;
	now: number;
	onFocus: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onOpen: () => void;
	registerRow: (element: HTMLElement | null) => void;
	row: RecordsRow;
}) {
	const tl = useLiteralMessages();
	const last = recordsRelativeTime(row.lastInteraction, now);
	return (
		<li>
			<button
				className="flex w-full flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left text-[13px] shadow-xs outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
				onClick={onOpen}
				onFocus={onFocus}
				onKeyDown={onKeyDown}
				ref={registerRow}
				tabIndex={isCursor ? 0 : -1}
				type="button"
			>
				<span className="flex min-w-0 items-center gap-2">
					<RecordsMark agent={row.agent} name={row.name} size={20} />
					<span className="truncate font-medium text-foreground">
						{row.name}
					</span>
				</span>
				<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
					{row.members.length > 0 ? (
						<RecordsFaces agents={row.members} limit={3} />
					) : null}
					<span className="truncate">
						{recordsPlural(row.threads.length, "thread")}
						{row.needsYou > 0 ? (
							<>
								{" · "}
								<span className="text-foreground">
									{tl(
										"{count, plural, one {{countLabel} needs} other {{countLabel} need}} you",
										{ count: row.needsYou, countLabel: String(row.needsYou) }
									)}
								</span>
							</>
						) : null}
					</span>
					{last && row.lastInteraction ? (
						<time
							className="ms-auto shrink-0 tabular-nums"
							dateTime={row.lastInteraction}
							title={recordsFullTime(row.lastInteraction)}
						>
							{last}
						</time>
					) : null}
				</span>
			</button>
		</li>
	);
}

/**
 * The records grouped by stage, one column per status. Empty columns stay so
 * the pipeline reads the same every time, as in Attio's kanban view.
 */
export function RecordsBoard({
	cursorId,
	now,
	onFocusRow,
	onKeyDownRow,
	onOpen,
	registerRow,
	rows,
}: {
	cursorId: string | null;
	now: number;
	onFocusRow: (id: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, id: string) => void;
	onOpen: (id: string) => void;
	registerRow: (id: string, element: HTMLElement | null) => void;
	rows: RecordsRow[];
}) {
	const columns = recordsBoard(rows);
	return (
		<div className="flex min-h-full gap-2 p-4" data-testid="records-board">
			{columns.map((column) => {
				const label = THREAD_STATUS_LABELS[column.status];
				return (
					<section
						aria-label={`${label}, ${column.rows.length}`}
						className="flex w-0 min-w-56 max-w-80 flex-1 flex-col gap-1 rounded-lg bg-muted/50 p-1"
						key={column.status}
					>
						<header className="flex h-8 shrink-0 items-center gap-2 px-2">
							<BoardStatusDot status={column.status} />
							<h3 className="text-[13px] text-foreground">{label}</h3>
							<span className="text-muted-foreground text-xs tabular-nums">
								{column.rows.length}
							</span>
						</header>
						{column.rows.length > 0 ? (
							<ul className="flex flex-col gap-1">
								{column.rows.map((row) => (
									<BoardCard
										isCursor={row.id === cursorId}
										key={row.id}
										now={now}
										onFocus={() => onFocusRow(row.id)}
										onKeyDown={(event) => onKeyDownRow(event, row.id)}
										onOpen={() => onOpen(row.id)}
										registerRow={(element) => registerRow(row.id, element)}
										row={row}
									/>
								))}
							</ul>
						) : (
							<p className="px-2 pb-2 text-muted-foreground text-xs leading-5">
								No records
							</p>
						)}
					</section>
				);
			})}
		</div>
	);
}
