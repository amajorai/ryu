// apps/desktop/src/components/chat/ScopeDefaultsPanel.tsx
//
// Model defaults for the thread in view, with where each value comes from.
//
// Every scope holds coordinator defaults (main threads) and thread defaults
// (sessions). The cascade (most specific wins) is
//   session > this bot in this project > this bot > the bot's own model >
//   this project > Settings › Models > the node default
// and Core resolves it at turn time. This panel shows what this thread runs on
// with its source ("Inherited from Atlas"), and lets the user set or reset the
// project-, bot-in-project- and bot-level scopes that apply to it. The session
// level is the composer's own model control; the node-wide level lives in
// Gateway › Defaults.

import { modelDefaultCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelDefaultsFields } from "@/src/components/chat/ModelDefaultsFields.tsx";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	agentScope,
	clearScopeDefault,
	type DefaultsRole,
	defaultSourceLabel,
	type EffectiveDefaults,
	EMPTY_SCOPE_DEFAULT,
	fetchEffectiveDefaults,
	fetchScopeDefaults,
	projectAgentScope,
	projectScope,
	type ScopeDefault,
	setScopeDefault,
} from "@/src/lib/api/hierarchy.ts";
import {
	inheritedBelow,
	inheritedForCoordinator,
	isScopeSet,
	type StoredLevel,
} from "@/src/lib/model-defaults.ts";

interface ScopeRow {
	label: string;
	level: StoredLevel;
	scope: string;
}

/** The editable scopes for a thread, most specific first. */
export function scopeRowsFor(input: {
	agentId?: string;
	agentName?: string;
	projectId?: string;
	projectName?: string;
	tl: LiteralMessage;
}): ScopeRow[] {
	const rows: ScopeRow[] = [];
	const agent = input.agentName || input.agentId;
	const project = input.projectName || "this project";
	if (input.projectId && input.agentId) {
		rows.push({
			label: `${agent} in ${project}`,
			level: "project_agent",
			scope: projectAgentScope(input.projectId, input.agentId),
		});
	}
	if (input.agentId) {
		rows.push({
			label: `${agent} everywhere`,
			level: "agent",
			scope: agentScope(input.agentId),
		});
	}
	if (input.projectId) {
		rows.push({
			label: input.tl("Everything in {project}", { project }),
			level: "project",
			scope: projectScope(input.projectId),
		});
	}
	return rows;
}

function ScopeEditor({
	effective,
	initial,
	label,
	level,
	onReset,
	onSave,
	target,
}: {
	effective: Record<DefaultsRole, EffectiveDefaults | null>;
	initial: ScopeDefault;
	label: string;
	level: StoredLevel;
	onReset: () => Promise<void>;
	onSave: (value: ScopeDefault) => Promise<void>;
	target: ApiTarget;
}) {
	const [draft, setDraft] = useState<ScopeDefault>(initial);
	const [busy, setBusy] = useState(false);
	useEffect(() => setDraft(initial), [initial]);
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	return (
		<fieldset className="flex flex-col gap-3 rounded-lg border border-border p-2.5">
			<legend className="px-1 font-medium text-xs">{label}</legend>
			<ModelDefaultsFields
				disabled={busy}
				inherited={{
					coordinator: inheritedForCoordinator(
						effective.coordinator?.levels,
						level,
						initial
					),
					thread: inheritedBelow(effective.thread?.levels, level),
				}}
				onChange={setDraft}
				target={target}
				value={draft}
			/>
			<div className="flex items-center justify-end gap-2">
				{isScopeSet(initial) ? (
					<Button
						disabled={busy}
						onClick={() => void run(onReset)}
						size="sm"
						variant="ghost"
					>
						Reset to inherited
					</Button>
				) : null}
				<Button
					disabled={busy}
					onClick={() => void run(() => onSave(draft))}
					size="sm"
				>
					Save
				</Button>
			</div>
		</fieldset>
	);
}

function ResolvedLine({
	effective,
	label,
	names,
}: {
	effective: EffectiveDefaults | null;
	label: string;
	names: { agent?: string; project?: string };
}) {
	const tl = useLiteralMessages();
	const resolved = effective?.resolved;
	if (!resolved) {
		return null;
	}
	return (
		<p className="text-muted-foreground text-xs">
			<span className="text-foreground">{label}: </span>
			{resolved.model ? (
				<>
					<span className="text-foreground">{resolved.model}</span>
					{" · "}
					{defaultSourceLabel(resolved.model_source, names)}
				</>
			) : (
				"the node picks a model"
			)}
			{resolved.effort
				? ` · ${tl("{effort} effort ({effortSource})", {
						effort: resolved.effort,
						effortSource: defaultSourceLabel(
							resolved.effort_source,
							names
						).toLowerCase(),
					})}`
				: ""}
		</p>
	);
}

export function ScopeDefaultsPanel({
	agentId,
	agentName,
	isMainThread,
	projectId,
	projectName,
	target,
}: {
	agentId?: string;
	agentName?: string;
	/** Whether the thread in view is a main (coordinator) thread. */
	isMainThread?: boolean;
	projectId?: string;
	projectName?: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [effective, setEffective] = useState<
		Record<DefaultsRole, EffectiveDefaults | null>
	>({ coordinator: null, thread: null });
	// `null` until the stored scopes load. The editors stay hidden until then:
	// a save writes every field, so editing from an empty stand-in would
	// replace stored defaults the user never saw.
	const [stored, setStored] = useState<Record<string, ScopeDefault> | null>(
		null
	);
	const [error, setError] = useState<string | null>(null);
	// A model change held until the user confirms the cache reset it causes.
	const [pendingModelChange, setPendingModelChange] = useState<{
		confirmation: PromptCacheConfirmation;
		resolve: (apply: boolean) => void;
	} | null>(null);
	// Only the newest load may commit, so a slow response for a previous
	// node or thread never lands over the current one.
	const loadSeq = useRef(0);

	const load = useCallback(async () => {
		const seq = ++loadSeq.current;
		const input = { agentId, inheritedOnly: true, projectId };
		const [coordinator, thread, nextStored] = await Promise.allSettled([
			fetchEffectiveDefaults(target, { ...input, role: "coordinator" }),
			fetchEffectiveDefaults(target, { ...input, role: "thread" }),
			fetchScopeDefaults(target),
		]);
		if (seq !== loadSeq.current) {
			return;
		}
		// The resolved lines and inherited labels are optional.
		setEffective({
			coordinator:
				coordinator.status === "fulfilled" ? coordinator.value : null,
			thread: thread.status === "fulfilled" ? thread.value : null,
		});
		if (nextStored.status === "fulfilled") {
			setStored(nextStored.value);
			setError(null);
		} else {
			const cause = nextStored.reason;
			setError(
				cause instanceof Error ? cause.message : "Couldn't load model defaults."
			);
		}
	}, [agentId, projectId, target]);

	useEffect(() => {
		setStored(null);
		void load();
	}, [load]);

	const rows = scopeRowsFor({
		agentId,
		agentName,
		projectId,
		projectName,
		tl,
	});

	/** Resolve true to go ahead. Both the thread and the coordinator pair move
	 * cache keys, so either changing asks first. */
	const confirmModelChange = (
		label: string,
		before: ScopeDefault,
		after: ScopeDefault
	): Promise<boolean> => {
		const confirmation =
			modelDefaultCacheWarning(label, before, after) ??
			modelDefaultCacheWarning(
				label,
				{
					model: before.coordinatorModel ?? "",
					provider: before.coordinatorProvider ?? "",
				},
				{
					model: after.coordinatorModel ?? "",
					provider: after.coordinatorProvider ?? "",
				}
			);
		if (!confirmation) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) =>
			setPendingModelChange({ confirmation, resolve })
		);
	};
	const names = { agent: agentName || agentId, project: projectName };
	const ownRole: DefaultsRole = isMainThread ? "coordinator" : "thread";

	return (
		<div
			className="flex max-h-[70vh] w-96 flex-col gap-3 overflow-y-auto"
			data-testid="scope-defaults-panel"
		>
			<div className="flex flex-col gap-0.5">
				<p className="font-medium text-sm">Model defaults</p>
				<ResolvedLine
					effective={effective[ownRole]}
					label="This thread"
					names={names}
				/>
				{ownRole === "coordinator" ? (
					<ResolvedLine
						effective={effective.thread}
						label="Its sessions"
						names={names}
					/>
				) : null}
				<p className="mt-1 text-muted-foreground text-xs">
					The composer's model control overrides these for this session.
				</p>
			</div>
			{error ? (
				<div className="flex items-center justify-between gap-2">
					<p className="text-destructive text-xs" role="alert">
						{error}
					</p>
					{stored ? null : (
						<Button onClick={() => void load()} size="sm" variant="outline">
							Retry
						</Button>
					)}
				</div>
			) : null}
			{(stored ? rows : []).map((row) => (
				<ScopeEditor
					effective={effective}
					initial={stored?.[row.scope] ?? EMPTY_SCOPE_DEFAULT}
					key={row.scope}
					label={row.label}
					level={row.level}
					onReset={async () => {
						const before = stored?.[row.scope] ?? EMPTY_SCOPE_DEFAULT;
						if (
							!(await confirmModelChange(
								row.label,
								before,
								EMPTY_SCOPE_DEFAULT
							))
						) {
							return;
						}
						await clearScopeDefault(target, row.scope);
						await load();
					}}
					onSave={async (value) => {
						const before = stored?.[row.scope] ?? EMPTY_SCOPE_DEFAULT;
						if (!(await confirmModelChange(row.label, before, value))) {
							return;
						}
						await setScopeDefault(target, row.scope, value);
						await load();
					}}
					target={target}
				/>
			))}
			{rows.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					This chat follows your default models. Put it in a project to give it
					project defaults.
				</p>
			) : null}
			<PromptCacheConfirmDialog
				confirmation={pendingModelChange?.confirmation ?? null}
				onApply={() => {
					pendingModelChange?.resolve(true);
					setPendingModelChange(null);
				}}
				onCancel={() => {
					pendingModelChange?.resolve(false);
					setPendingModelChange(null);
				}}
			/>
		</div>
	);
}
