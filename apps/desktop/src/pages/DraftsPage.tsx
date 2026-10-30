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

import { Cards01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";

import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";

import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	DraftsCardSpread,
	type DraftsSendResult,
} from "@/src/components/drafts/DraftsCardSpread.tsx";
import { PageBody, PageTop } from "@/src/components/views/page-layout.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
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
	saveDraft,
	saveDraftsSettings,
} from "@/src/lib/api/drafts.ts";
import {
	draftsListQuery,
	draftsSentQuery,
	draftsSettingsQuery,
} from "@/src/lib/route-queries.ts";
import { compactAge } from "@/src/lib/time.ts";
import { DraftCard, errorMessage, SettingsPanel } from "./DraftsPage.parts.tsx";

export default function DraftsPage() {
	const node = useActiveNode();
	const openTab = useTabSelector((state) => state.openTab);
	const target = toTarget(node);
	const queryClient = useQueryClient();
	const [composing, setComposing] = useState("");
	const [spreadOpen, setSpreadOpen] = useState(false);
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
		...draftsListQuery(target),
		refetchInterval: 5000,
	});
	const sent = useQuery(draftsSentQuery(target));
	const settings = useQuery(draftsSettingsQuery(target));

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
		mutationFn: ({ draft, text }: { draft: DraftWire; text: string }) =>
			saveDraft(target, {
				id: draft.id,
				text,
				// The sidecar upserts a complete draft from POST; omit these and an
				// edit silently becomes a manual draft with its send context cleared.
				conversation_id: draft.conversation_id,
				agent_id: draft.agent_id,
				model: draft.model,
				folder_path: draft.folder_path,
				source: draft.source,
				trigger: draft.trigger,
			}),
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
	const actionErrorForDraft = (id: string): string | null => {
		const failures = [
			save.variables?.draft.id === id ? save.error : null,
			arm.variables?.id === id ? arm.error : null,
			disarm.variables === id ? disarm.error : null,
			remove.variables === id ? remove.error : null,
		];
		return errorMessage(failures.find((failure) => failure !== null) ?? null);
	};

	// "Send" from the card table. Not a direct send: each draft is re-armed to go
	// out now, and the app's dispatcher sends it on its next tick through
	// `chat.startTurn` — the same path, and the same Approvals gate, as every
	// other queued draft.
	const sendFromTable = async (ids: string[]): Promise<DraftsSendResult> => {
		const results = await Promise.allSettled(
			ids.map((id) =>
				armDraft(target, id, { kind: "at", epoch_ms: Date.now() })
			)
		);
		invalidate();
		const result: DraftsSendResult = { failed: [], sent: [] };
		for (const [index, outcome] of results.entries()) {
			const id = ids[index];
			if (id === undefined) {
				continue;
			}
			if (outcome.status === "fulfilled") {
				result.sent.push(id);
			} else {
				result.failed.push({
					id,
					message: errorMessage(outcome.reason) ?? "The send failed.",
				});
			}
		}
		return result;
	};

	const rows = drafts.data ?? [];

	return (
		<PageBody>
			<PageTop
				subtitle="Messages you have not sent, and what each one is waiting for."
				title="Drafts"
			/>
			<section className="flex flex-col gap-2">
				<Textarea
					aria-label="New draft"
					className="min-h-20"
					onChange={(e) => setComposing(e.target.value)}
					placeholder="Write a draft to send later…"
					typography="small"
					value={composing}
				/>
				<Button
					className="self-end"
					disabled={!composing.trim() || create.isPending}
					onClick={() => create.mutate(composing)}
					size="sm"
					variant="outline"
				>
					Save draft
				</Button>
				{create.error ? (
					<p
						aria-live="polite"
						className="text-sm text-status-destructive"
						role="alert"
					>
						{errorMessage(create.error)}
					</p>
				) : null}
			</section>

			{settings.data && (
				<SettingsPanel
					error={errorMessage(putSettings.error)}
					onChange={(next) => putSettings.mutate(next)}
					settings={settings.data}
				/>
			)}

			<section>
				<div className="mb-1 flex items-center gap-2">
					<h2 className="font-semibold text-sm">Outbox</h2>
					{rows.length > 0 ? (
						<Button
							className="ml-auto"
							onClick={() => setSpreadOpen(true)}
							size="sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon icon={Cards01Icon} size={16} />
							Deal as cards
						</Button>
					) : null}
				</div>
				{drafts.isLoading ? (
					<SkeletonRows spacing="library" />
				) : rows.length === 0 ? (
					<Empty>
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
								variant="outline"
							>
								Open a new chat
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<div className="flex flex-col">
						{rows.map((draft) => (
							<DraftCard
								actionError={actionErrorForDraft(draft.id)}
								agents={agentOptions}
								draft={draft}
								key={draft.id}
								onArm={(id, trigger) => arm.mutate({ id, trigger })}
								onDelete={(id) => remove.mutate(id)}
								onDisarm={(id) => disarm.mutate(id)}
								onSave={(draft, text) => save.mutate({ draft, text })}
								settings={settings.data}
							/>
						))}
					</div>
				)}
			</section>

			<DraftsCardSpread
				drafts={rows}
				onOpenChange={setSpreadOpen}
				onSend={sendFromTable}
				open={spreadOpen}
			/>

			{(sent.data?.length ?? 0) > 0 && (
				<section>
					<h2 className="mb-1 font-semibold text-sm">Sent</h2>
					<div className="flex flex-col">
						{(sent.data ?? []).map((draft) => (
							<div
								className={cn(
									"flex h-10 items-center gap-2 border-border border-b last:border-b-0"
								)}
								key={draft.id}
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-muted-foreground"
									icon={SentIcon}
								/>
								<span className="truncate text-sm" title={draft.preview}>
									{draft.preview}
								</span>
								<span className="ml-auto shrink-0 text-muted-foreground/70 text-xs tabular-nums">
									{draft.sent_at ? compactAge(draft.sent_at) : ""}
								</span>
							</div>
						))}
					</div>
				</section>
			)}
		</PageBody>
	);
}
