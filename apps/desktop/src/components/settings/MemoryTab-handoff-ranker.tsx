import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ContextHandoffPolicy,
	getContextHandoffPolicy,
	getToolRanker,
	parseContextHandoffPolicy,
	setContextHandoffPolicy,
	setToolRanker,
	type ToolRankerId,
} from "@/src/lib/api/preferences.ts";
import { persist, useMemoryOwner } from "./MemoryTab-owner.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

// ── Context handoff on model change ──────────────────────────────────────────
// `context.handoff-on-model-change`: whether switching a conversation's model
// hands the earlier history to the new model as a one-time summary. Independent
// of the budget card above, and on by default for smaller-context switches.

const HANDOFF_ITEMS: { value: ContextHandoffPolicy; label: string }[] = [
	{
		value: "smaller-context",
		label: "When the new model's context is smaller (default)",
	},
	{ value: "different-provider", label: "When the provider changes" },
	{ value: "always", label: "On every model change" },
	{ value: "off", label: "Never — send the whole conversation" },
];

export function ContextHandoffSection({ target }: { target: ApiTarget }) {
	const captureOwner = useMemoryOwner(target);
	const [policy, setPolicy] = useState<ContextHandoffPolicy>("smaller-context");

	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		getContextHandoffPolicy(target)
			.then((value) => {
				if (!cancelled && isCurrent()) {
					setPolicy(value);
				}
			})
			.catch(() => {
				// Leaves the default showing, which is what Core applies when the
				// pref is unreadable.
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);

	const handleChange = useCallback(
		(value: string | null) => {
			const isCurrent = captureOwner();
			if (!isCurrent || value === null) {
				return;
			}
			const previous = policy;
			const next = parseContextHandoffPolicy(value);
			setPolicy(next);
			persist(
				setContextHandoffPolicy(target, next),
				isCurrent,
				"the handoff setting",
				() => setPolicy(previous)
			);
		},
		[policy, target, captureOwner]
	);

	return (
		<SettingsSection
			caption="When you switch a chat to another model, Ryu can summarize everything said so far once and give the new model that summary plus the messages after the switch. A “Context handed off” marker shows where it happened. By default this only happens when the new model's context window is smaller and the chat no longer fits it, such as going from a 1M-token model to a 256K one. The summary is written by the summarizer model from Conversation context when one is set, then this node's default model, otherwise the model you switched from."
			title="Model switch handoff"
		>
			<SettingsCard>
				<div className="space-y-1.5">
					<Label htmlFor="context-handoff">Hand off context</Label>
					<Select
						items={HANDOFF_ITEMS}
						onValueChange={handleChange}
						value={policy}
					>
						<SelectTrigger className="h-9 w-full" id="context-handoff">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{HANDOFF_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Tool / skill search ranking ──────────────────────────────────────────────
// `tools.active_ranker` picks how the unified tool catalog — and the skill
// search that reuses it — orders results. It lives here rather than beside a
// catalog-source picker because the desktop has no tool-catalog source selector,
// and this is the tab that already owns how skills reach the model.

const RANKER_ITEMS: { value: ToolRankerId; label: string }[] = [
	{ value: "needle2", label: "Needle 2 (on-device selector)" },
	{ value: "bm25", label: "Keyword (BM25)" },
	{ value: "semantic", label: "Meaning (embeddings)" },
];

export function ToolRankerSection({ target }: { target: ApiTarget }) {
	const captureOwner = useMemoryOwner(target);
	const [ranker, setRanker] = useState<ToolRankerId>("needle2");

	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		getToolRanker(target)
			.then((value) => {
				if (!cancelled && isCurrent()) {
					setRanker(value);
				}
			})
			.catch(() => {
				// Leaves the Needle 2 default showing, which is what Core uses when the
				// pref is unreadable.
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);

	const handleChange = useCallback(
		(value: string) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = ranker;
			// Mirrors Core's `ToolRanker::from_pref`: explicit BM25 and Semantic
			// values opt out of the Needle 2 default; unknown values use Needle 2.
			const next: ToolRankerId =
				value === "bm25"
					? "bm25"
					: value === "semantic"
						? "semantic"
						: "needle2";
			setRanker(next);
			persist(
				setToolRanker(target, next),
				isCurrent,
				"the search ranking",
				() => setRanker(previous)
			);
		},
		[ranker, target, captureOwner]
	);

	return (
		<SettingsSection
			caption="How Ryu picks which tools and skills to offer the model for a given request. Needle 2 is the default on-device selector and falls back to keyword order when its runtime is unavailable. Keyword matching is the explicit no-model option. Meaning-based ranking compares your request to each tool or skill using this node's embedding model."
			title="Tool and skill search"
		>
			<SettingsCard>
				<div className="space-y-1.5">
					<Label htmlFor="tool-ranker">Ranking</Label>
					<Select
						items={RANKER_ITEMS}
						onValueChange={handleChange}
						value={ranker}
					>
						<SelectTrigger className="h-9 w-full" id="tool-ranker">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RANKER_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
