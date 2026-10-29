import { MessageList } from "@ryu/blocks/desktop/agent-elements/message-list.tsx";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { DateCell } from "@ryu/ui/components/data-grid/data-grid-cell-variants.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { setTimezonePreference } from "@ryu/ui/lib/timezone.ts";
import {
	createTable,
	getCoreRowModel,
	type TableMeta,
} from "@tanstack/react-table";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

interface CalendarRecord {
	date: string;
	id: string;
	unrelated: string;
}
interface CalendarUpdate {
	columnId: string;
	rowIndex: number;
	value: unknown;
}
interface ProofWindow extends Window {
	__timeConsumersProof?: { selectLocale: (locale: string) => void };
}
const parameters = new URLSearchParams(location.search);
const view = parameters.get("view");
if (
	(view !== "transcript" && view !== "grid") ||
	parameters.getAll("view").length !== 1 ||
	[...parameters.keys()].some((key) => key !== "view")
) {
	throw new Error("Exactly one declared mounted consumer view is required");
}
// Seed timestamp-bearing shipping UIMessage records. No model, formatter,
// grouping, hook, transcript or calendar implementation is replaced.
const messages: Array<UIMessage & { createdAt: string }> = [
	{
		id: "retained-user",
		role: "user",
		createdAt: "2026-03-08T05:30:00.000Z",
		parts: [{ type: "text", text: "Retained midnight question" }],
	},
	{
		id: "retained-assistant",
		role: "assistant",
		createdAt: "2026-03-08T05:31:00.000Z",
		parts: [{ type: "text", text: "Retained midnight answer" }],
	},
];
const originalMessages = JSON.stringify(messages);
const originalRecords: CalendarRecord[] = [
	{ id: "edited", date: "2026-03-15", unrelated: "retained" },
	{ id: "foreign", date: "2025-12-31", unrelated: "other row" },
];
setTimezonePreference(
	view === "transcript" ? "America/New_York" : "Pacific/Kiritimati"
);

function DayAcknowledgment() {
	const revision = useDisplayDayRevision();
	return <output data-testid="day-acknowledgment">{revision}</output>;
}
function Transcript() {
	return (
		<>
			<DayAcknowledgment />
			<output data-testid="original-message-bytes">{originalMessages}</output>
			<output data-testid="current-message-bytes">
				{JSON.stringify(messages)}
			</output>
			<div className="h-[32rem]">
				<MessageList
					conversationKey="retained-time-conversation"
					initialScrollBehavior="top"
					messages={messages}
					status="ready"
				/>
			</div>
		</>
	);
}
function EditableCalendar() {
	const [records, setRecords] = useState<CalendarRecord[]>(() =>
		structuredClone(originalRecords)
	);
	const [editing, setEditing] = useState(false);
	const [updates, setUpdates] = useState<CalendarUpdate[]>([]);
	// Stable metadata keeps editor ownership independent of incidental fixture
	// renders. These are the real table's public consumer acknowledgments.
	const metadata = useMemo<TableMeta<CalendarRecord>>(
		() => ({
			onCellEditingStart: (rowIndex, columnId) => {
				if (rowIndex !== 0 || columnId !== "date") {
					throw new Error("Undeclared editing target");
				}
				setEditing(true);
			},
			onCellEditingStop: () => setEditing(false),
			onDataUpdate: (update) => {
				if (
					Array.isArray(update) ||
					update.rowIndex !== 0 ||
					update.columnId !== "date" ||
					typeof update.value !== "string"
				) {
					throw new Error("Unexpected public date-cell update");
				}
				const date = update.value;
				setUpdates((current) => [...current, update]);
				setRecords((current) =>
					current.map((record, index) =>
						index === update.rowIndex ? { ...record, date } : record
					)
				);
			},
		}),
		[]
	);
	const table = useMemo(
		() =>
			createTable({
				data: records,
				columns: [{ accessorKey: "date" }],
				getCoreRowModel: getCoreRowModel(),
				state: {},
				onStateChange: () => {},
				renderFallbackValue: null,
			}),
		[records]
	);
	const cell = table.getRowModel().rows[0]?.getAllCells()[0];
	if (!cell) {
		throw new Error("Actual TanStack date cell is absent");
	}
	return (
		<>
			<output data-testid="calendar-records">{JSON.stringify(records)}</output>
			<output data-testid="calendar-original-records">
				{JSON.stringify(originalRecords)}
			</output>
			<output data-testid="calendar-updates">{JSON.stringify(updates)}</output>
			<div aria-label="Actual date-cell consumer" role="grid">
				<DateCell
					cell={cell}
					columnId="date"
					isActiveSearchMatch={false}
					isEditing={editing}
					isFocused
					isSearchMatch={false}
					isSelected={false}
					readOnly={false}
					rowHeight="short"
					rowIndex={0}
					tableMeta={metadata}
				/>
			</div>
		</>
	);
}
function Fixture() {
	const [mounted, setMounted] = useState(true);
	const language = useI18n();
	useEffect(() => {
		const controller = { selectLocale: language.setLocale };
		(window as ProofWindow).__timeConsumersProof = controller;
		return () => {
			if ((window as ProofWindow).__timeConsumersProof === controller) {
				Reflect.deleteProperty(window, "__timeConsumersProof");
			}
		};
	}, [language.setLocale]);
	return (
		<main className="mx-auto max-w-3xl p-8">
			<button
				data-testid="unmount-consumer"
				onClick={() => setMounted(false)}
				type="button"
			>
				Unmount mounted consumer
			</button>
			<output data-testid="consumer-mounted">{String(mounted)}</output>
			<output data-testid="provider-locale">{language.locale}</output>
			{mounted &&
				(view === "transcript" ? <Transcript /> : <EditableCalendar />)}
		</main>
	);
}
const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing owned fixture mount");
}
createRoot(container).render(
	<I18nProvider initialLocale="en-US">
		<TooltipProvider>
			<Fixture />
		</TooltipProvider>
	</I18nProvider>
);
