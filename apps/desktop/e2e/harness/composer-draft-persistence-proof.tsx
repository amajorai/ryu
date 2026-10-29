import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { parseProofJsonRecord } from "../fixture-json.ts";
// Browser proof for the real AgentChat composer. The desktop's persistence hook
// writes these same draft ids to the Drafts sidecar; this hermetic story uses a
// local durable adapter so tab switching and a cold remount can be inspected
// without a running Core node.

import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "../../components/agent-elements/agent-chat.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import "../../src/index.css";

const STORAGE_KEY = "ryu-proof-composer-drafts";

// Keep the proof's storage adapter aligned with the production key contract:
// `composer_<conversation>` and the one `composer_launchpad` row.
function draftIdFor(conversationId?: string): string {
	const key = (conversationId ?? "launchpad").replace(/[^a-zA-Z0-9_-]/g, "");
	return `composer_${key}`.slice(0, 64);
}

interface ProofTab {
	conversationId?: string;
	group: "conversation" | "launchpad";
	id: string;
	label: string;
}

const TABS: ProofTab[] = [
	{
		conversationId: "conversation-a",
		group: "conversation",
		id: "conversation-a",
		label: "Conversation A",
	},
	{
		conversationId: "conversation-b",
		group: "conversation",
		id: "conversation-b",
		label: "Conversation B",
	},
	{
		group: "launchpad",
		id: "launchpad-one",
		label: "New chat 1",
	},
	{
		group: "launchpad",
		id: "launchpad-two",
		label: "New chat 2",
	},
];

type DraftRows = Record<string, string>;

function readRows(): DraftRows {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = parseProofJsonRecord(raw);
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] =>
				isNativeText(entry[1])
			)
		);
	} catch {
		return {};
	}
}

function writeRows(rows: DraftRows) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

function rowIdFor(tab: ProofTab): string {
	return draftIdFor(tab.conversationId);
}

function ProofInputBar({
	onChange,
	value,
}: {
	onChange?: (value: string) => void;
	value?: unknown;
}) {
	return (
		<textarea
			aria-label="Send a message"
			className="min-h-24 w-full resize-none rounded-lg border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary"
			onChange={(event) => onChange?.(event.target.value)}
			placeholder="Write an unsent draft…"
			rows={4}
			value={isNativeText(value) ? value : ""}
		/>
	);
}

function DraftTab({
	tab,
	onRowsChange,
}: {
	onRowsChange: (rows: DraftRows) => void;
	tab: ProofTab;
}) {
	const rowId = rowIdFor(tab);
	const initialDraft = useMemo(() => readRows()[rowId] ?? "", [rowId]);
	const firstObservation = useRef(true);

	const onDraftChange = useCallback(
		(draft: string) => {
			// AgentChat reports its initial empty state on mount. It is an observation,
			// not a request to delete a durable row before the seed is applied.
			if (firstObservation.current && draft.length === 0) {
				firstObservation.current = false;
				return;
			}
			firstObservation.current = false;
			const rows = readRows();
			if (draft.trim().length === 0) {
				delete rows[rowId];
			} else {
				rows[rowId] = draft;
			}
			writeRows(rows);
			onRowsChange(rows);
		},
		[rowId, onRowsChange]
	);

	return (
		<div className="h-64" data-testid={`composer-tab-${tab.id}`}>
			<AgentChat
				currentUser={{ id: "proof-user", name: "You" }}
				messages={[]}
				onDraftChange={onDraftChange}
				onSend={() => undefined}
				onStop={() => undefined}
				seedDraft={initialDraft || undefined}
				slots={{ InputBar: ProofInputBar }}
				status="ready"
			/>
			<div className="mt-2 text-muted-foreground text-xs">
				Row: <code>{rowId}</code>
			</div>
			<div className="sr-only" data-testid={`draft-value-${tab.id}`}>
				{initialDraft}
			</div>
		</div>
	);
}

function Story() {
	const [activeTab, setActiveTab] = useState(TABS[0].id);
	const [revision, setRevision] = useState(0);
	const [reopenCount, setReopenCount] = useState(0);
	const [rows, setRows] = useState<DraftRows>(() => readRows());

	const refreshRows = useCallback(() => setRows(readRows()), []);
	const handleColdReopen = useCallback(() => {
		setRevision((current) => current + 1);
		setReopenCount((current) => current + 1);
		refreshRows();
	}, [refreshRows]);
	const handleReset = useCallback(() => {
		localStorage.removeItem(STORAGE_KEY);
		setRows({});
		setRevision((current) => current + 1);
		setReopenCount(0);
	}, []);

	const conversationRows = Object.keys(rows).filter((id) =>
		id.startsWith("composer_conversation-")
	);
	const launchpadRow = rows[draftIdFor()];

	return (
		<ChatDisplayPrefs>
			<div className="min-h-screen bg-background p-6 text-foreground">
				<div className="mx-auto flex max-w-3xl flex-col gap-5">
					<header className="flex flex-col gap-2">
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
							Drafts app · browser proof
						</p>
						<h1 className="font-semibold text-2xl tracking-tight">
							Composer text survives tabs and restarts
						</h1>
						<p className="max-w-2xl text-muted-foreground text-sm">
							These are the real AgentChat composers. Conversation tabs get one
							durable row each; new chats share one launchpad row, so only the
							latest unsent prompt returns after a cold reopen.
						</p>
					</header>

					<section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
						<div className="flex flex-wrap gap-2" role="tablist">
							{TABS.map((tab) => (
								<button
									aria-selected={activeTab === tab.id}
									className={`rounded-md px-3 py-2 text-sm ${activeTab === tab.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
									key={tab.id}
									onClick={() => setActiveTab(tab.id)}
									role="tab"
									type="button"
								>
									{tab.label}
								</button>
							))}
						</div>

						<div className="rounded-lg border bg-background p-3">
							{TABS.map((tab) => (
								<div
									aria-hidden={activeTab !== tab.id}
									className={activeTab === tab.id ? "" : "hidden"}
									key={`${tab.id}-${revision}`}
								>
									<DraftTab onRowsChange={setRows} tab={tab} />
								</div>
							))}
						</div>

						<div className="flex flex-wrap gap-2">
							<button
								className="rounded-md border px-3 py-2 font-medium text-sm hover:bg-muted"
								onClick={handleColdReopen}
								type="button"
							>
								Simulate app close + reopen
							</button>
							<button
								className="rounded-md border px-3 py-2 text-muted-foreground text-sm hover:bg-muted"
								onClick={handleReset}
								type="button"
							>
								Reset proof data
							</button>
						</div>
					</section>

					<section
						aria-live="polite"
						className="grid gap-3 sm:grid-cols-4"
						data-testid="persistence-status"
					>
						<div className="rounded-lg border p-3">
							<div className="text-muted-foreground text-xs">Durable rows</div>
							<div
								className="font-semibold text-xl"
								data-testid="durable-row-count"
							>
								{Object.keys(rows).length}
							</div>
						</div>
						<div className="rounded-lg border p-3">
							<div className="text-muted-foreground text-xs">
								Conversation rows
							</div>
							<div
								className="font-semibold text-xl"
								data-testid="conversation-row-count"
							>
								{conversationRows.length}
							</div>
						</div>
						<div className="rounded-lg border p-3">
							<div className="text-muted-foreground text-xs">
								Latest launchpad
							</div>
							<div
								className="truncate font-medium text-sm"
								data-testid="latest-launchpad"
							>
								{launchpadRow ?? "—"}
							</div>
						</div>
						<div className="rounded-lg border p-3">
							<div className="text-muted-foreground text-xs">Cold reopens</div>
							<div className="font-semibold text-xl" data-testid="reopen-count">
								{reopenCount}
							</div>
						</div>
					</section>
					<p className="text-muted-foreground text-xs">
						Click <em>Simulate app close + reopen</em> after editing to remount
						every composer from its durable row.
					</p>
				</div>
			</div>
		</ChatDisplayPrefs>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
