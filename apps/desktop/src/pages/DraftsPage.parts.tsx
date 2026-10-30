import { Clock01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { DefaultError } from "@tanstack/react-query";
import { useState } from "react";
import type {
	DraftsSettings,
	DraftTrigger,
	DraftWire,
} from "@/src/lib/api/drafts.ts";
import { compactAge } from "@/src/lib/time.ts";

/** The concurrency ceiling a one-click arm uses when the user has not set one. */
export const DEFAULT_BELOW = 1;

/** The percentage a usage window must fall below for a `usage_reset` draft to go.
 *  Not 100: a window sitting at 99.4% has not reset, it is merely not quite full,
 *  and a draft armed on "has room again" should mean the cap actually lifted. */
export const USAGE_ROOM_PERCENT = 90;

export function errorMessage(error: DefaultError | null): string | null {
	if (error instanceof Error) {
		return error.message;
	}
	return error ? "The Drafts request failed." : null;
}

/** The trigger a row can be armed with, and what to call it. `at` is deliberately
 *  absent from the picker — the sidecar supports it, but a date/time control is a
 *  different piece of UI and none of the conditions people are actually blocked by
 *  needs one. */
export type ArmKind = "concurrency" | "all_done" | "usage_reset";

/** The trigger a picker selection means. Total: an unresolved usage pick (no agent
 *  chosen) degrades to the concurrency rule rather than arming something the
 *  sidecar would hold forever. */
export function triggerFor(
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

export function TriggerEditor({
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
				<SelectTrigger
					aria-label="Queue condition"
					className="w-[240px]"
					size="sm"
				>
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
					<SelectTrigger
						aria-label="Agent for usage reset"
						className="w-[180px]"
						size="sm"
					>
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
				variant="outline"
			>
				<HugeiconsIcon className="mr-1 size-4" icon={Clock01Icon} />
				Queue it
			</Button>
		</div>
	);
}

export function DraftCard({
	agents,
	draft,
	actionError,
	onArm,
	onDelete,
	onDisarm,
	onSave,
	settings,
}: {
	agents: { id: string; name: string }[];
	actionError?: string | null;
	draft: DraftWire;
	onArm: (id: string, trigger: DraftTrigger) => void;
	onDelete: (id: string) => void;
	onDisarm: (id: string) => void;
	onSave: (draft: DraftWire, text: string) => void;
	settings?: DraftsSettings;
}) {
	const tl = useLiteralMessages();
	const [text, setText] = useState(draft.text);
	const dirty = text !== draft.text;
	const armed = draft.state === "armed";
	// Arming defaults to the node's own ceiling, so "queue this" means the same
	// thing here as it does when the composer auto-queues a send.
	const below = settings?.max_concurrent ?? DEFAULT_BELOW;
	const waitingFor = (() => {
		const trigger = draft.trigger;
		if (draft.state === "armed" && trigger.kind === "usage_reset") {
			const agentName =
				agents.find((agent) => agent.id === trigger.agent_id)?.name ??
				trigger.agent_id;
			return `Waiting for ${agentName} to drop under ${trigger.below_percent}% used`;
		}
		return draft.waiting_for;
	})();

	return (
		<div
			aria-label={tl("Draft: {preview}", { preview: draft.preview })}
			className="border-border border-b py-4 last:border-b-0"
			role="group"
		>
			<div className="mb-2 flex items-center gap-2">
				{draft.state === "failed" ? (
					<Badge variant="destructive">{draft.state_label}</Badge>
				) : (
					<span className="font-medium text-sm">{draft.state_label}</span>
				)}
				{waitingFor && (
					<span
						className="truncate text-detail text-muted-foreground"
						title={waitingFor}
					>
						{waitingFor}
					</span>
				)}
				<span className="ml-auto shrink-0 text-muted-foreground/70 text-xs tabular-nums">
					{compactAge(draft.updated_at)}
				</span>
			</div>
			<Textarea
				aria-label="Draft message"
				className="min-h-20"
				onChange={(e) => setText(e.target.value)}
				typography="small"
				value={text}
			/>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					disabled={!dirty}
					onClick={() => onSave(draft, text)}
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
					aria-label={tl("Delete draft: {preview}", {
						preview: draft.preview,
					})}
					className="ml-auto"
					onClick={() => onDelete(draft.id)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			</div>
			{draft.error || actionError ? (
				<p
					aria-live="polite"
					className="mt-2 text-sm text-status-destructive"
					role="alert"
				>
					{draft.error ?? actionError}
				</p>
			) : null}
		</div>
	);
}

export function SettingsPanel({
	error,
	onChange,
	settings,
}: {
	error?: string | null;
	onChange: (next: DraftsSettings) => void;
	settings: DraftsSettings;
}) {
	return (
		<section>
			<h2 className="mb-1 font-semibold text-sm">
				When drafts are made for you
			</h2>
			<div className="flex flex-col [&>*:not(:last-child)]:border-border [&>*:not(:last-child)]:border-b [&>*]:min-h-12 [&>*]:py-3">
				<div className="flex items-center justify-between gap-6">
					<div className="min-w-0">
						<Label variant="choice">Keep unsent composer text</Label>
						<p className="text-detail text-muted-foreground">
							Text left in a chat composer is kept here instead of lost.
						</p>
					</div>
					<Switch
						aria-label="Keep unsent composer text"
						checked={settings.autosave_enabled}
						onCheckedChange={(autosave_enabled: boolean) =>
							onChange({ ...settings, autosave_enabled })
						}
					/>
				</div>
				<div className="flex items-center justify-between gap-6">
					<div className="min-w-0">
						<Label variant="choice">Queue sends when already busy</Label>
						<p className="text-detail text-muted-foreground">
							Sends wait while all runs are busy, then go out on their own.
						</p>
					</div>
					<Switch
						aria-label="Queue sends when already busy"
						checked={settings.auto_queue_enabled}
						onCheckedChange={(auto_queue_enabled: boolean) =>
							onChange({ ...settings, auto_queue_enabled })
						}
					/>
				</div>
				<div className="flex items-center justify-between gap-6">
					<Label htmlFor="drafts-max-concurrent" variant="choice">
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
			{error ? (
				<p
					aria-live="polite"
					className="mt-3 text-sm text-status-destructive"
					role="alert"
				>
					{error}
				</p>
			) : null}
		</section>
	);
}
