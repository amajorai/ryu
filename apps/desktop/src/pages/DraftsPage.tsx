// apps/desktop/src/pages/DraftsPage.tsx
//
// Drafts: every message you have not sent yet, and what each one is waiting for.
//
// The sidebar section answers "what is in the outbox". This page is where a draft
// is actually worked on — edited, given a condition, sent now, or thrown away —
// because a `sidebar_sections[].spec` can only LIST rows, and clicking one is
// deliberately limited to plain navigation (`parseContributedTarget` allowlists
// `conversationId` and nothing else, precisely so a manifest can never hand the
// user a row that sends a message on click).
//
// A SHELL page owned by an APP: the component ships here, but the feature belongs
// to `@ryu/drafts`, which declares where it lives via
// `contributes.sidebar_buttons[].target` and owns the store behind `/api/drafts/*`.
// See `contributions/app-shell-routes.ts`.
//
// The page does not send. The app's own sidecar does, on its own tick
// (`apps-store/drafts/backend/src/dispatch.rs`), through the granted `chat.startTurn`
// kernel capability — so a queued draft goes out whether or not this window is open.

import {
	Clock01Icon,
	Delete02Icon,
	FileEditIcon,
	SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { cn } from "@ryu/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	armDraft,
	type DraftsSettings,
	type DraftTrigger,
	type DraftWire,
	deleteDraft,
	disarmDraft,
	getDraftsSettings,
	listDrafts,
	listSentDrafts,
	saveDraft,
	saveDraftsSettings,
} from "@/src/lib/api/drafts.ts";
import { compactAge } from "@/src/lib/time.ts";

/** How many sent drafts the history shows. Enough to answer "did the thing I
 *  queued last night actually go out", not an archive browser. */
const HISTORY_LIMIT = 25;

/** The concurrency ceiling a one-click arm uses when the user has not set one. */
const DEFAULT_BELOW = 1;

/** The percentage a usage window must fall below for a `usage_reset` draft to go.
 *  Not 100: a window sitting at 99.4% has not reset, it is merely not quite full,
 *  and a draft armed on "has room again" should mean the cap actually lifted. */
const USAGE_ROOM_PERCENT = 90;

/** The trigger a row can be armed with, and what to call it. `at` is deliberately
 *  absent from the picker — the sidecar supports it, but a date/time control is a
 *  different piece of UI and none of the conditions people are actually blocked by
 *  needs one. */
type ArmKind = "concurrency" | "all_done" | "usage_reset";

/** The trigger a picker selection means. Total: an unresolved usage pick (no agent
 *  chosen) degrades to the concurrency rule rather than arming something the
 *  sidecar would hold forever. */
function triggerFor(
	kind: ArmKind,
	agentId: string | null,
	below: number
): DraftTrigger {
	if (kind === "all_done") {
		return { kind: "all_done" };
	}
	if (kind === "usage_reset" && agentId) {
		return {
			kind: "usage_reset",
			agent_id: agentId,
			below_percent: USAGE_ROOM_PERCENT,
		};
	}
	return { kind: "concurrency", below };
}

function TriggerEditor({
	agents,
	onArm,
	below,
}: {
	agents: { id: string; name: string }[];
	below: number;
	onArm: (trigger: DraftTrigger) => void;
}) {
	// "when everything finishes" leads because it is the one people reach for by
	// name — the release prompt that should go out after the agents are done.
	const [kind, setKind] = useState<ArmKind>("all_done");
	const [agentId, setAgentId] = useState<string | null>(agents[0]?.id ?? null);

	const kindOptions = [
		{ value: "all_done", label: "when everything finishes" },
		{ value: "concurrency", label: "when a slot frees" },
		{ value: "usage_reset", label: "when a limit lifts" },
	];

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select
				items={kindOptions}
				onValueChange={(value: string | null) =>
					setKind(
						value === "usage_reset" || value === "concurrency"
							? value
							: "all_done"
					)
				}
				value={kind}
			>
				<SelectTrigger className="w-[180px]" size="sm">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{kindOptions.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{kind === "usage_reset" && (
				<Select
					items={agents.map((a) => ({ value: a.id, label: a.name }))}
					onValueChange={setAgentId}
					value={agentId}
				>
					<SelectTrigger className="w-[180px]" size="sm">
						<SelectValue placeholder="Which subscription" />
					</SelectTrigger>
					<SelectContent>
						{agents.map((agent) => (
							<SelectItem key={agent.id} value={agent.id}>
								{agent.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			<Button
				disabled={kind === "usage_reset" && !agentId}
				onClick={() => onArm(triggerFor(kind, agentId, below))}
				size="sm"
			>
				<HugeiconsIcon className="mr-1 size-4" icon={Clock01Icon} />
				Queue it
			</Button>
		</div>
	);
}

function DraftCard({
	agents,
	draft,
	onArm,
	onDelete,
	onDisarm,
	onSave,
	settings,
}: {
	agents: { id: string; name: string }[];
	draft: DraftWire;
	onArm: (id: string, trigger: DraftTrigger) => void;
	onDelete: (id: string) => void;
	onDisarm: (id: string) => void;
	onSave: (id: string, text: string) => void;
	settings?: DraftsSettings;
}) {
	const [text, setText] = useState(draft.text);
	const dirty = text !== draft.text;
	const armed = draft.state === "armed";
	// Arming defaults to the node's own ceiling, so "queue this" means the same
	// thing here as it does when the composer auto-queues a send.
	const below = settings?.max_concurrent ?? DEFAULT_BELOW;

	return (
		<div className="rounded-lg border bg-card/40 p-3">
			<div className="mb-2 flex items-center gap-2">
				<Badge variant={draft.state === "failed" ? "destructive" : "secondary"}>
					{draft.state_label}
				</Badge>
				{draft.waiting_for && (
					<span className="truncate text-muted-foreground text-xs">
						{draft.waiting_for}
					</span>
				)}
				<span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
					{compactAge(draft.updated_at)}
				</span>
			</div>
			<Textarea
				className="min-h-20 text-sm"
				onChange={(e) => setText(e.target.value)}
				value={text}
			/>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					disabled={!dirty}
					onClick={() => onSave(draft.id, text)}
					size="sm"
					variant="ghost"
				>
					Save
				</Button>
				{armed ? (
					<Button onClick={() => onDisarm(draft.id)} size="sm" variant="ghost">
						Unqueue
					</Button>
				) : (
					<TriggerEditor
						agents={agents}
						below={below}
						onArm={(trigger) => onArm(draft.id, trigger)}
					/>
				)}
				<Button
					className="ml-auto"
					onClick={() => onDelete(draft.id)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			</div>
			{draft.error && (
				<p className="mt-2 text-destructive text-xs">{draft.error}</p>
			)}
		</div>
	);
}

function SettingsPanel({
	onChange,
	settings,
}: {
	onChange: (next: DraftsSettings) => void;
	settings: DraftsSettings;
}) {
	return (
		<section className="rounded-lg border bg-card/40 p-3">
			<h2 className="mb-3 font-medium text-sm">When drafts are made for you</h2>
			<div className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<Label className="text-sm">Keep unsent composer text</Label>
						<p className="text-muted-foreground text-xs">
							Leave a chat with something typed and it is kept here instead of
							being lost with the tab.
						</p>
					</div>
					<Switch
						checked={settings.autosave_enabled}
						onCheckedChange={(autosave_enabled: boolean) =>
							onChange({ ...settings, autosave_enabled })
						}
					/>
				</div>
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<Label className="text-sm">Queue sends when already busy</Label>
						<p className="text-muted-foreground text-xs">
							Pressing send while this many agents are running queues the
							message instead. It goes out on its own when a slot frees.
						</p>
					</div>
					<Switch
						checked={settings.auto_queue_enabled}
						onCheckedChange={(auto_queue_enabled: boolean) =>
							onChange({ ...settings, auto_queue_enabled })
						}
					/>
				</div>
				<div className="flex items-center justify-between gap-3">
					<Label className="text-sm" htmlFor="drafts-max-concurrent">
						Concurrent runs allowed
					</Label>
					<Input
						className="w-20"
						id="drafts-max-concurrent"
						min={1}
						onChange={(e) =>
							onChange({
								...settings,
								// A ceiling of 0 would queue everything with nothing able to
								// release it; the sidecar clamps too, this just keeps the
								// control honest.
								max_concurrent: Math.max(1, Number(e.target.value) || 1),
							})
						}
						type="number"
						value={settings.max_concurrent}
					/>
				</div>
			</div>
		</section>
	);
}

export default function DraftsPage() {
	const node = useActiveNode();
	const { openTab } = useTabsContext();
	const target = toTarget(node);
	const queryClient = useQueryClient();
	const [composing, setComposing] = useState("");
	// The agents a `usage_reset` draft can name. Every agent is offered rather than
	// only the ones with a readable subscription: whether a window is readable is a
	// runtime fact that changes with login state, and hiding the option would make
	// the feature look absent rather than merely unavailable right now. An agent
	// whose usage cannot be read simply never satisfies the trigger — fail-closed,
	// same as every other unknown reading.
	const { agents: agentSummaries } = useAgents();
	const agentOptions = useMemo(
		() => agentSummaries.map((a) => ({ id: a.id, name: a.name })),
		[agentSummaries]
	);

	const drafts = useQuery({
		queryKey: ["drafts-list", target.url],
		queryFn: () => listDrafts(target),
		refetchInterval: 5000,
	});
	const sent = useQuery({
		queryKey: ["drafts-sent", target.url],
		queryFn: () => listSentDrafts(target, HISTORY_LIMIT),
	});
	const settings = useQuery({
		queryKey: ["drafts-settings", target.url],
		queryFn: () => getDraftsSettings(target),
	});

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: ["drafts-list"] });
		queryClient.invalidateQueries({ queryKey: ["drafts-sent"] });
	};

	const create = useMutation({
		mutationFn: (text: string) => saveDraft(target, { text, source: "manual" }),
		onSuccess: () => {
			setComposing("");
			invalidate();
		},
	});
	const save = useMutation({
		mutationFn: ({ id, text }: { id: string; text: string }) =>
			saveDraft(target, { id, text }),
		onSuccess: invalidate,
	});
	const arm = useMutation({
		mutationFn: ({ id, trigger }: { id: string; trigger: DraftTrigger }) =>
			armDraft(target, id, trigger),
		onSuccess: invalidate,
	});
	const disarm = useMutation({
		mutationFn: (id: string) => disarmDraft(target, id),
		onSuccess: invalidate,
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteDraft(target, id),
		onSuccess: invalidate,
	});
	const putSettings = useMutation({
		mutationFn: (next: DraftsSettings) => saveDraftsSettings(target, next),
		onSuccess: (next) => {
			queryClient.setQueryData(["drafts-settings", target.url], next);
		},
	});

	const rows = drafts.data ?? [];

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
				<HugeiconsIcon className="size-5" icon={FileEditIcon} />
				<div>
					<h1 className="font-medium text-base">Drafts</h1>
					<p className="text-muted-foreground text-xs">
						Messages you have not sent, and what each one is waiting for.
					</p>
				</div>
			</header>

			<div className="scroll-fade flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
				<section className="rounded-lg border bg-card/40 p-3">
					<Textarea
						className="min-h-20 text-sm"
						onChange={(e) => setComposing(e.target.value)}
						placeholder="Write a draft to send later…"
						value={composing}
					/>
					<Button
						className="mt-2"
						disabled={!composing.trim() || create.isPending}
						onClick={() => create.mutate(composing)}
						size="sm"
					>
						Save draft
					</Button>
				</section>

				{settings.data && (
					<SettingsPanel
						onChange={(next) => putSettings.mutate(next)}
						settings={settings.data}
					/>
				)}

				<section>
					<h2 className="mb-2 font-medium text-sm">Outbox</h2>
					{drafts.isLoading ? (
						<div className="flex justify-center p-6">
							<Spinner />
						</div>
					) : rows.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyTitle>No drafts</EmptyTitle>
								<EmptyDescription>
									Type into a composer and leave without sending — the text is
									kept here instead of being lost.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button
									onClick={() => openTab("/chat", { forceNew: true })}
									size="sm"
								>
									Open a new chat
								</Button>
							</EmptyContent>
						</Empty>
					) : (
						<div className="flex flex-col gap-2">
							{rows.map((draft) => (
								<DraftCard
									agents={agentOptions}
									draft={draft}
									key={draft.id}
									onArm={(id, trigger) => arm.mutate({ id, trigger })}
									onDelete={(id) => remove.mutate(id)}
									onDisarm={(id) => disarm.mutate(id)}
									onSave={(id, text) => save.mutate({ id, text })}
									settings={settings.data}
								/>
							))}
						</div>
					)}
				</section>

				{(sent.data?.length ?? 0) > 0 && (
					<section>
						<h2 className="mb-2 font-medium text-sm">Sent</h2>
						<div className="flex flex-col gap-1">
							{(sent.data ?? []).map((draft) => (
								<div
									className={cn(
										"flex items-center gap-2 rounded-md border bg-card/20 px-3 py-2"
									)}
									key={draft.id}
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={SentIcon}
									/>
									<span className="truncate text-sm">{draft.preview}</span>
									<span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
										{draft.sent_at ? compactAge(draft.sent_at) : ""}
									</span>
								</div>
							))}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
