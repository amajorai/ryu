import {
	Add01Icon,
	DatabaseIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
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
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createMemory,
	getMemorySettings,
	setMemorySettings,
} from "@/src/lib/api/memory.ts";
import {
	AUTO_RECALL_MAX_TOP_K,
	AUTO_RECALL_MIN_TOP_K,
	CONTEXT_MAX_OUTPUT_RESERVE,
	CONTEXT_MIN_BUDGET_TOKENS,
	CONTEXT_MIN_OUTPUT_RESERVE,
	type ContextBudget,
	contextHistoryBudget,
	getAutoRecallEnabled,
	getAutoRecallTopK,
	getContextAutoCompact,
	getContextBudget,
	getContextCompactConfig,
	getContextOutputReserve,
	getSkillsProgressive,
	getToolRanker,
	type SideModelConfig,
	setAutoRecallEnabled,
	setAutoRecallTopK,
	setContextAutoCompact,
	setContextBudget,
	setContextCompactConfig,
	setContextOutputReserve,
	setSkillsProgressive,
	setToolRanker,
	type ToolRankerId,
} from "@/src/lib/api/preferences.ts";
import {
	listSpaceSummaries,
	type ScoredChunk,
	type SpaceSummary,
	searchRetrieval,
} from "@/src/lib/api/retrieval.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Shared with ChatPage so the long-term memory opt-in is one setting, not two.
const LONG_TERM_MEMORY_KEY = "ryu_long_term_memory";

function sourceLabel(chunk: ScoredChunk, spaces: SpaceSummary[]): string {
	if (chunk.source === "memory") {
		return "Memory";
	}
	const space = spaces.find((s) => s.id === chunk.spaceId);
	return space ? `Space · ${space.name}` : "Space";
}

/**
 * Run a preference write and surface a failure. The node is the only store for
 * these values, so a write that silently fails would leave the control showing a
 * setting the node never received — exactly the "settable value that cannot take
 * effect" this tab exists to avoid.
 */
function persist(write: Promise<boolean>, what: string): void {
	const failed = () => {
		toast.error({
			title: `Couldn't save ${what}`,
			description: "Your change wasn't saved. Please try again.",
		});
	};
	write
		.then((ok) => {
			if (!ok) {
				failed();
			}
		})
		.catch(failed);
}

// ── Conversation context window ──────────────────────────────────────────────
// One card for the five `context.*` preferences Core reads per turn. Off by
// default in Core, and every control below the budget select is inert while the
// budget is off (`resolve_context_window` returns before reading them), so they
// render disabled rather than pretending to be live.

/** Budgets offered as one-click presets, in tokens. */
const CONTEXT_PRESETS = [4096, 8192, 16_384, 32_768, 65_536, 131_072];
/** Sentinel select values (Base UI Select is unreliable with empty strings). */
const BUDGET_OFF = "off";
const BUDGET_AUTO = "auto";
const BUDGET_CUSTOM = "custom";
/** Seed for a Custom pick made from Off/Auto, where there is no current number. */
const CUSTOM_SEED_TOKENS = 8192;

const BUDGET_ITEMS = [
	{ value: BUDGET_OFF, label: "Off — send the whole conversation" },
	{
		value: BUDGET_AUTO,
		label: "Auto — needs a context size set for the model",
	},
	...CONTEXT_PRESETS.map((n) => ({
		value: String(n),
		label: `${formatNumber(n)} tokens`,
	})),
	{ value: BUDGET_CUSTOM, label: "Custom…" },
];

const RANKER_ITEMS: { value: ToolRankerId; label: string }[] = [
	{ value: "bm25", label: "Keyword (BM25)" },
	{ value: "semantic", label: "Meaning (embeddings)" },
];

function ContextWindowSection({ target }: { target: ApiTarget }) {
	const [budget, setBudget] = useState<ContextBudget>({ kind: "off" });
	// A Custom pick is sticky: the number input stays open even when the typed
	// value happens to equal a preset, so the field doesn't vanish mid-edit.
	const [customOpen, setCustomOpen] = useState(false);
	const [customText, setCustomText] = useState(String(CUSTOM_SEED_TOKENS));
	const [reserve, setReserve] = useState(0);
	const [reserveText, setReserveText] = useState("");
	const [autoCompact, setAutoCompact] = useState(false);
	const [compactModel, setCompactModel] = useState<SideModelConfig>({
		provider: "",
		model: "",
		effort: "",
	});

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			getContextBudget(target),
			getContextOutputReserve(target),
			getContextAutoCompact(target),
			getContextCompactConfig(target),
		])
			.then(([storedBudget, storedReserve, compact, model]) => {
				if (cancelled) {
					return;
				}
				setBudget(storedBudget);
				if (storedBudget.kind === "tokens") {
					setCustomText(String(storedBudget.tokens));
					setCustomOpen(!CONTEXT_PRESETS.includes(storedBudget.tokens));
				}
				setReserve(storedReserve);
				setReserveText(String(storedReserve));
				setAutoCompact(compact);
				setCompactModel(model);
			})
			.catch(() => {
				// Unreachable node: the defaults above already show "off", which is
				// what an unconfigured node does. Nothing is written on mount.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const saveBudget = useCallback(
		(next: ContextBudget) => {
			setBudget(next);
			persist(setContextBudget(target, next), "the context budget");
		},
		[target]
	);

	// Base UI's Select can emit `null` (a cleared selection); there is no "no
	// budget" state distinct from Off, so a null is simply ignored.
	const handleBudgetSelect = useCallback(
		(value: string | null) => {
			if (value === null) {
				return;
			}
			if (value === BUDGET_CUSTOM) {
				setCustomOpen(true);
				const seed =
					budget.kind === "tokens" ? budget.tokens : CUSTOM_SEED_TOKENS;
				setCustomText(String(seed));
				saveBudget({ kind: "tokens", tokens: seed });
				return;
			}
			setCustomOpen(false);
			if (value === BUDGET_OFF) {
				saveBudget({ kind: "off" });
				return;
			}
			if (value === BUDGET_AUTO) {
				saveBudget({ kind: "auto" });
				return;
			}
			saveBudget({ kind: "tokens", tokens: Number.parseInt(value, 10) });
		},
		[budget, saveBudget]
	);

	// Typing is free-form; the clamp lands on blur so a half-typed "1" doesn't
	// snap to the floor under the cursor.
	const commitCustom = useCallback(() => {
		const parsed = Number.parseInt(customText.trim(), 10);
		if (!Number.isFinite(parsed)) {
			setCustomText(
				budget.kind === "tokens"
					? String(budget.tokens)
					: String(CUSTOM_SEED_TOKENS)
			);
			return;
		}
		// Same rule as the reply reserve: a blur that changed nothing writes
		// nothing, so a budget stored below this floor by other means is not
		// rewritten behind the user's back.
		if (budget.kind === "tokens" && parsed === budget.tokens) {
			setCustomText(String(parsed));
			return;
		}
		const clamped = Math.max(parsed, CONTEXT_MIN_BUDGET_TOKENS);
		setCustomText(String(clamped));
		saveBudget({ kind: "tokens", tokens: clamped });
	}, [budget, customText, saveBudget]);

	const commitReserve = useCallback(() => {
		const parsed = Number.parseInt(reserveText.trim(), 10);
		if (!Number.isFinite(parsed)) {
			setReserveText(String(reserve));
			return;
		}
		// A blur with no edit must not write: the node's stored value can sit
		// outside the range this control offers (nothing stops `PUT
		// /api/preferences/context.max-output-tokens`), and clamping it on a
		// stray focus would silently rewrite a setting the user never touched.
		if (parsed === reserve) {
			setReserveText(String(parsed));
			return;
		}
		const clamped = Math.min(
			Math.max(parsed, CONTEXT_MIN_OUTPUT_RESERVE),
			CONTEXT_MAX_OUTPUT_RESERVE
		);
		setReserve(clamped);
		setReserveText(String(clamped));
		persist(setContextOutputReserve(target, clamped), "the reply reserve");
	}, [reserve, reserveText, target]);

	const handleAutoCompact = useCallback(
		(next: boolean) => {
			setAutoCompact(next);
			persist(setContextAutoCompact(target, next), "auto-compact");
		},
		[target]
	);

	const handleCompactModel = useCallback(
		(next: SideModelConfig) => {
			setCompactModel(next);
			persist(setContextCompactConfig(target, next), "the summarizer model");
		},
		[target]
	);

	const off = budget.kind === "off";
	const selectValue = (() => {
		if (customOpen) {
			return BUDGET_CUSTOM;
		}
		if (budget.kind === "tokens") {
			return String(budget.tokens);
		}
		return budget.kind === "auto" ? BUDGET_AUTO : BUDGET_OFF;
	})();
	const historyCeiling =
		budget.kind === "tokens"
			? contextHistoryBudget(budget.tokens, reserve)
			: null;

	return (
		<SettingsSection
			caption="Off by default. With a budget set, Ryu keeps the newest turns that fit and always keeps the system prompt (your instructions, recalled memory and skills), which the engine's own overflow handling can otherwise drop. Everything below the budget is ignored while it is off."
			title="Conversation context"
		>
			<SettingsCard className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="context-budget">Context budget</Label>
					<Select
						items={BUDGET_ITEMS}
						onValueChange={handleBudgetSelect}
						value={selectValue}
					>
						<SelectTrigger className="h-9 w-full text-sm" id="context-budget">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{BUDGET_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-muted-foreground text-xs">
						Total tokens per turn, request plus reply. <strong>Auto</strong>{" "}
						reuses the “Context size” saved for the model in an agent's engine
						settings, which only local engines offer. A model without one (any
						cloud model, and any local model you haven't set it on) keeps
						sending the whole conversation, so pick a number if you are unsure.
					</p>
				</div>

				{customOpen ? (
					<div className="space-y-1.5">
						<Label htmlFor="context-budget-custom">
							Custom budget (tokens)
						</Label>
						<Input
							className="h-9"
							id="context-budget-custom"
							inputMode="numeric"
							onBlur={commitCustom}
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setCustomText(e.target.value)
							}
							value={customText}
						/>
						<p className="text-muted-foreground text-xs">
							Minimum {formatNumber(CONTEXT_MIN_BUDGET_TOKENS)}. Below that
							there is no room left for history and every turn would be sent
							with just your last message.
						</p>
					</div>
				) : null}

				<div className="space-y-1.5">
					<Label htmlFor="context-reserve">
						Reserved for the reply (tokens)
					</Label>
					<Input
						className="h-9"
						disabled={off}
						id="context-reserve"
						inputMode="numeric"
						onBlur={commitReserve}
						onChange={(e: ChangeEvent<HTMLInputElement>) =>
							setReserveText(e.target.value)
						}
						value={reserveText}
					/>
					<p className="text-muted-foreground text-xs">
						Held back from the budget so the answer has room.{" "}
						{historyCeiling === null
							? "Applies once a budget is set."
							: `Leaves at most ${formatNumber(historyCeiling)} tokens for history, less once your system prompt, recalled memory and skills are counted.`}
					</p>
				</div>

				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="context-auto-compact">
						Summarize older turns instead of dropping them
					</Label>
					<Switch
						checked={autoCompact}
						disabled={off}
						id="context-auto-compact"
						onCheckedChange={handleAutoCompact}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					Turns that fall outside the budget are sent to the model below for a
					short summary, added to the conversation as an “Earlier conversation
					summary” note. Costs one extra model call whenever the window
					overflows.
				</p>

				{autoCompact && !off ? (
					<SideModelPicker
						onChange={handleCompactModel}
						target={target}
						value={compactModel}
					/>
				) : null}
				{autoCompact && !off ? (
					<p className="text-muted-foreground text-xs">
						Leave the model blank to use this node's default agent or model; if
						no default is set, the summary is written by whichever model you are
						chatting with.
					</p>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

// ── Tool / skill search ranking ──────────────────────────────────────────────
// `tools.active_ranker` picks how the unified tool catalog — and the skill
// search that reuses it — orders results. It lives here rather than beside a
// catalog-source picker because the desktop has no tool-catalog source selector,
// and this is the tab that already owns how skills reach the model.

function ToolRankerSection({ target }: { target: ApiTarget }) {
	const [ranker, setRanker] = useState<ToolRankerId>("bm25");

	useEffect(() => {
		let cancelled = false;
		getToolRanker(target)
			.then((value) => {
				if (!cancelled) {
					setRanker(value);
				}
			})
			.catch(() => {
				// Leaves the BM25 default showing, which is what Core uses when the
				// pref is unreadable.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleChange = useCallback(
		(value: string) => {
			// Mirrors Core's `ToolRanker::from_pref`: only the exact "semantic"
			// selects semantic ranking, so a cleared selection means BM25 — the
			// same thing an unset preference means.
			const next: ToolRankerId = value === "semantic" ? "semantic" : "bm25";
			setRanker(next);
			persist(setToolRanker(target, next), "the search ranking");
		},
		[target]
	);

	return (
		<SettingsSection
			caption="How Ryu picks which tools and skills to offer the model for a given request. Keyword matching is the default and needs nothing installed. Meaning-based ranking compares your request to each tool or skill using the embedding model this node is configured with. Where no embedding model is reachable, it quietly falls back to keyword order rather than failing the search."
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
						<SelectTrigger className="h-9 w-full text-sm" id="tool-ranker">
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

export function MemoryTab() {
	const activeNode = useActiveNode();
	// Memoize so this object is stable across renders — the data-loading effects
	// depend on it and would otherwise re-fire on every keystroke.
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	// Long-term (cross-session) memory is opt-in per the privacy-by-default
	// principle. Persisted in the same localStorage key the chat transport reads,
	// so toggling it here changes what chat recalls and survives restarts.
	const [longTermMemory, setLongTermMemory] = useState<boolean>(
		() => localStorage.getItem(LONG_TERM_MEMORY_KEY) === "true"
	);
	const handleLongTermChange = useCallback((next: boolean) => {
		setLongTermMemory(next);
		localStorage.setItem(LONG_TERM_MEMORY_KEY, String(next));
	}, []);

	// Sensitive-topic consent is stored by Core per user/node, not in
	// localStorage or the node-global preference table. Core defaults it off and
	// applies it to capture, recall, search, and graph snapshots.
	const [includeSensitiveTopics, setIncludeSensitiveTopics] = useState(false);
	useEffect(() => {
		let cancelled = false;
		setIncludeSensitiveTopics(false);
		getMemorySettings(target)
			.then((settings) => {
				if (!cancelled) {
					setIncludeSensitiveTopics(settings.includeSensitiveTopics);
				}
			})
			.catch(() => {
				// Unavailable or unauthenticated nodes fail closed to off.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const handleSensitiveTopicsChange = useCallback(
		(next: boolean) => {
			setIncludeSensitiveTopics(next);
			setMemorySettings(target, { includeSensitiveTopics: next }).catch(() => {
				setIncludeSensitiveTopics(!next);
				toast.error({
					title: "Couldn't save sensitive-memory consent",
					description: "Your change wasn't saved. Please try again.",
				});
			});
		},
		[target]
	);

	// Auto-recall (U17): before each chat turn Core retrieves relevant memory +
	// past chat messages and injects them into the prompt. Default ON; persisted in
	// Core under the `auto-recall-enabled` pref so it applies on every node-served
	// chat turn (not just this client).
	const [autoRecall, setAutoRecall] = useState<boolean>(true);
	useEffect(() => {
		let cancelled = false;
		getAutoRecallEnabled(target).then((value) => {
			if (!cancelled) {
				setAutoRecall(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const handleAutoRecallChange = useCallback(
		(next: boolean) => {
			setAutoRecall(next);
			setAutoRecallEnabled(target, next).catch(() => undefined);
		},
		[target]
	);

	// How many recalled snippets are injected per turn (`auto-recall-top-k`).
	// Kept as text while editing and clamped on blur, like the context inputs.
	// The displayed number is what this control WRITES: Core reads the pref
	// first but falls back to `RYU_AUTO_RECALL_TOP_K` when the pref is unset,
	// and the desktop cannot see the node's environment.
	const [topKText, setTopKText] = useState("");
	// The value currently stored on the node, so a blur that changed nothing can
	// be told apart from an edit. Core accepts any positive integer here, so a
	// stored value can legitimately sit above the range this control offers.
	const [topKSaved, setTopKSaved] = useState<number | null>(null);
	useEffect(() => {
		let cancelled = false;
		getAutoRecallTopK(target).then((value) => {
			if (!cancelled) {
				setTopKSaved(value);
				setTopKText(String(value));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const commitTopK = useCallback(() => {
		const parsed = Number.parseInt(topKText.trim(), 10);
		if (!Number.isFinite(parsed)) {
			setTopKText(topKSaved === null ? "" : String(topKSaved));
			return;
		}
		if (parsed === topKSaved) {
			setTopKText(String(parsed));
			return;
		}
		const clamped = Math.min(
			Math.max(parsed, AUTO_RECALL_MIN_TOP_K),
			AUTO_RECALL_MAX_TOP_K
		);
		setTopKSaved(clamped);
		setTopKText(String(clamped));
		persist(setAutoRecallTopK(target, clamped), "the recall limit");
	}, [target, topKSaved, topKText]);

	// Skills disclosure: progressive (default) injects only an L1 skill index and
	// loads full bodies on demand via the `skills.load` tool, saving context on
	// low-context models; full injects every enabled skill body each turn.
	const [skillsProgressive, setSkillsProgressiveState] =
		useState<boolean>(true);
	useEffect(() => {
		let cancelled = false;
		getSkillsProgressive(target).then((value) => {
			if (!cancelled) {
				setSkillsProgressiveState(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [target]);
	const handleSkillsProgressiveChange = useCallback(
		(next: boolean) => {
			setSkillsProgressiveState(next);
			setSkillsProgressive(target, next).catch(() => undefined);
		},
		[target]
	);

	const [spaces, setSpaces] = useState<SpaceSummary[]>([]);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<ScoredChunk[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const [indexContent, setIndexContent] = useState("");
	const [indexing, setIndexing] = useState(false);
	const [indexStatus, setIndexStatus] = useState<string | null>(null);
	const [indexError, setIndexError] = useState<string | null>(null);

	// Load Space names once so retrieved chunks can be labelled with their origin.
	useEffect(() => {
		let cancelled = false;
		listSpaceSummaries(target)
			.then((list) => {
				if (!cancelled) {
					setSpaces(list);
				}
			})
			.catch(() => {
				// Spaces are only used for labelling; a failure here is non-fatal.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleSearch = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			const trimmed = query.trim();
			if (!trimmed) {
				return;
			}
			setSearching(true);
			setSearchError(null);
			try {
				const chunks = await searchRetrieval(target, {
					query: trimmed,
					includeMemory: true,
				});
				setResults(chunks);
			} catch {
				setSearchError("Couldn't search memory. Please try again.");
				setResults(null);
			} finally {
				setSearching(false);
			}
		},
		[query, target]
	);

	const handleIndex = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			const trimmed = indexContent.trim();
			if (!trimmed) {
				return;
			}
			setIndexing(true);
			setIndexStatus(null);
			setIndexError(null);
			try {
				await createMemory(target, { content: trimmed });
				setIndexStatus("Saved to memory.");
				setIndexContent("");
			} catch {
				setIndexError("Couldn't save that to memory. Please try again.");
			} finally {
				setIndexing(false);
			}
		},
		[indexContent, target]
	);

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Off by default. When on, Ryu remembers durable facts across conversations and recalls them in future chats. This choice is shared with the chat view and persists across restarts."
				title="Long-term memory"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={longTermMemory}
								id="long-term-memory"
								onCheckedChange={handleLongTermChange}
							/>
						}
						title="Remember facts across conversations"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={includeSensitiveTopics}
								id="include-sensitive-topics"
								onCheckedChange={handleSensitiveTopicsChange}
							/>
						}
						description="Allows Ryu to capture and recall sensitive topics such as health conditions and religious beliefs. Off by default; existing sensitive memories stay hidden while it is off."
						title="Include sensitive topics in memory"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default. Before each reply, Ryu finds relevant snippets from your long-term memory and past conversations and gives them to the model as background context. It never blocks a reply if this is unavailable, and it skips the current conversation."
				title="Auto-recall"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={autoRecall}
								id="auto-recall"
								onCheckedChange={handleAutoRecallChange}
							/>
						}
						title="Automatically recall relevant context"
					/>
					<SettingsItem
						actions={
							<Input
								aria-label="Snippets recalled per reply"
								className="h-8 w-20 text-right"
								// Nothing is recalled at all while the switch above is off, so
								// this limit would be a number that cannot take effect.
								disabled={!autoRecall}
								inputMode="numeric"
								onBlur={commitTopK}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setTopKText(e.target.value)
								}
								value={topKText}
							/>
						}
						description={`How many snippets from memory and past chats are added to a reply. Lower this if replies feel cluttered with old context; raise it for better recall on long-running work. This control writes ${AUTO_RECALL_MIN_TOP_K}–${AUTO_RECALL_MAX_TOP_K}; a larger number set outside the app is shown as-is and left alone until you change it.`}
						title="Snippets per reply"
					/>
				</SettingsGroup>
			</SettingsSection>

			<ContextWindowSection target={target} />

			<SettingsSection
				caption="On by default. Instead of giving the model every enabled skill's full instructions on every reply, Ryu shares a short list and the agent loads a skill's full instructions on demand when relevant, which saves context on smaller local models. Only agents that run tools (the default Ryu agent) load on demand; others always get full instructions. Turn off to always include full skill instructions."
				title="Skill loading"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={skillsProgressive}
								id="skills-progressive"
								onCheckedChange={handleSkillsProgressiveChange}
							/>
						}
						title="Load skills on demand"
					/>
				</SettingsGroup>
			</SettingsSection>

			<ToolRankerSection target={target} />

			<SettingsSection
				caption="Run a similarity search across long-term memory and indexed Space documents. Results are ranked by relevance score."
				title="Search memory and Spaces"
			>
				<SettingsCard className="flex flex-col gap-3">
					<form className="flex gap-2" onSubmit={handleSearch}>
						<Input
							aria-label="Search query"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setQuery(e.target.value)
							}
							placeholder="What do you want to recall?"
							value={query}
						/>
						<Button disabled={!query.trim()} loading={searching} type="submit">
							{!searching && (
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							)}
							Search
						</Button>
					</form>

					{searchError ? (
						<p className="text-destructive text-sm">{searchError}</p>
					) : null}

					{results !== null && results.length === 0 && !searchError ? (
						<Empty className="py-8">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={DatabaseIcon} />
								</EmptyMedia>
								<EmptyTitle>No matches found</EmptyTitle>
								<EmptyDescription>
									Nothing in memory or Spaces matched that query yet.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button onClick={() => setQuery("")} size="sm" variant="ghost">
									Clear search
								</Button>
							</EmptyContent>
						</Empty>
					) : null}

					{results && results.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{results.map((chunk) => (
								<li
									className="rounded-md bg-muted/40 p-3 text-sm"
									key={chunk.id}
								>
									<div className="mb-1.5 flex items-center justify-between gap-2">
										<Badge variant="secondary">
											{sourceLabel(chunk, spaces)}
										</Badge>
										<span className="font-mono text-muted-foreground text-xs">
											score {chunk.score.toFixed(3)}
										</span>
									</div>
									<p className="whitespace-pre-wrap text-foreground">
										{chunk.content}
									</p>
								</li>
							))}
						</ul>
					) : null}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Manually add a piece of text to long-term memory so Ryu can recall it later."
				title="Add to memory"
			>
				{/* `bare`: what the card holds is one tall textarea plus its OWN status
				    line and submit button — not sibling settings — so the surface only
				    draws a second edge around the textarea's border. */}
				<SettingsCard bare>
					<form className="flex flex-col gap-3" onSubmit={handleIndex}>
						<Textarea
							aria-label="Text to remember"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setIndexContent(e.target.value)
							}
							placeholder="Text to remember…"
							rows={3}
							value={indexContent}
						/>
						{indexStatus ? (
							<p className="text-muted-foreground text-sm">{indexStatus}</p>
						) : null}
						{indexError ? (
							<p className="text-destructive text-sm">{indexError}</p>
						) : null}
						<div className="flex justify-end">
							<Button
								disabled={!indexContent.trim()}
								loading={indexing}
								type="submit"
							>
								{!indexing && (
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
								)}
								Add to memory
							</Button>
						</div>
					</form>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
