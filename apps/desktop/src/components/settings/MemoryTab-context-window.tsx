import { useLiteralMessages } from "@ryu/i18n/react";
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
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { CORE_LOCAL_ENGINES } from "@/src/lib/api/local-engines.ts";
import {
	CONTEXT_MAX_OUTPUT_RESERVE,
	CONTEXT_MIN_BUDGET_TOKENS,
	CONTEXT_MIN_OUTPUT_RESERVE,
	type ContextBudget,
	contextHistoryBudget,
	getContextAutoCompact,
	getContextBudget,
	getContextCompactConfig,
	getContextCompactOnCacheExpire,
	getContextOutputReserve,
	getScopedContextBudgetOverrides,
	type ScopedContextBudgetOverride,
	type SideModelConfig,
	setContextAutoCompact,
	setContextBudget,
	setContextCompactConfig,
	setContextCompactOnCacheExpire,
	setContextOutputReserve,
} from "@/src/lib/api/preferences.ts";
import {
	BUDGET_AUTO,
	BUDGET_CUSTOM,
	BUDGET_ITEMS,
	BUDGET_OFF,
	CONTEXT_PRESETS,
	CUSTOM_SEED_TOKENS,
	scopedOverrideEffect,
} from "./MemoryTab-context-budget.ts";
import { persist, useMemoryOwner } from "./MemoryTab-owner.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

// ── Conversation context window ──────────────────────────────────────────────
// One card for the five `context.*` preferences Core reads per turn. Off by
// default in Core, and every control below the budget select is inert while the
// budget is off (`resolve_context_window` returns before reading them), so they
// render disabled rather than pretending to be live.

export function ContextWindowSection({ target }: { target: ApiTarget }) {
	const captureOwner = useMemoryOwner(target);
	const tl = useLiteralMessages();
	const [budget, setBudget] = useState<ContextBudget>({ kind: "off" });
	const [scopedOverrides, setScopedOverrides] = useState<
		ScopedContextBudgetOverride[]
	>([]);
	// A Custom pick is sticky: the number input stays open even when the typed
	// value happens to equal a preset, so the field doesn't vanish mid-edit.
	const [customOpen, setCustomOpen] = useState(false);
	const [customText, setCustomText] = useState(String(CUSTOM_SEED_TOKENS));
	const [reserve, setReserve] = useState(0);
	const [reserveText, setReserveText] = useState("");
	const [autoCompact, setAutoCompact] = useState(false);
	const [compactOnCacheExpire, setCompactOnCacheExpire] = useState(false);
	const [compactModel, setCompactModel] = useState<SideModelConfig>({
		provider: "",
		model: "",
		effort: "",
	});

	useEffect(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
		let cancelled = false;
		Promise.all([
			getContextBudget(target),
			getContextOutputReserve(target),
			getContextAutoCompact(target),
			getContextCompactConfig(target),
			getContextCompactOnCacheExpire(target),
		])
			.then(([storedBudget, storedReserve, compact, model, onExpiry]) => {
				if (cancelled || !isCurrent()) {
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
				setCompactOnCacheExpire(onExpiry);
			})
			.catch(() => {
				// Unreachable node: the defaults above already show "off", which is
				// what an unconfigured node does. Nothing is written on mount.
			});
		// Read on its own so a failed scoped read never blanks the card above.
		// Core has no list route, so this checks `.local` plus the per-engine key
		// of every local engine Core knows; a cloud engine's key is named in the
		// caption only.
		getScopedContextBudgetOverrides(target, CORE_LOCAL_ENGINES)
			.then((overrides) => {
				if (!cancelled && isCurrent()) {
					setScopedOverrides(overrides);
				}
			})
			.catch(() => {
				// Unreachable node: no note, matching the "off" default above.
			});
		return () => {
			cancelled = true;
		};
	}, [target, captureOwner]);

	const saveBudget = useCallback(
		(next: ContextBudget) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = budget;
			const previousCustomOpen = customOpen;
			setBudget(next);
			persist(
				setContextBudget(target, next),
				isCurrent,
				"the context budget",
				() => {
					setBudget(previous);
					setCustomOpen(previousCustomOpen);
				}
			);
		},
		[budget, customOpen, target, captureOwner]
	);

	// Base UI's Select can emit `null` (a cleared selection); there is no "no
	// budget" state distinct from Off, so a null is simply ignored.
	const handleBudgetSelect = useCallback(
		(value: string | null) => {
			const isCurrent = captureOwner();
			if (!isCurrent || value === null) {
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
		[budget, saveBudget, captureOwner]
	);

	// Typing is free-form; the clamp lands on blur so a half-typed "1" doesn't
	// snap to the floor under the cursor.
	const commitCustom = useCallback(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
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
	}, [budget, customText, saveBudget, captureOwner]);

	const commitReserve = useCallback(() => {
		const isCurrent = captureOwner();
		if (!isCurrent) {
			return;
		}
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
		persist(
			setContextOutputReserve(target, clamped),
			isCurrent,
			"the reply reserve",
			() => {
				setReserve(reserve);
				setReserveText(String(reserve));
			}
		);
	}, [reserve, reserveText, target, captureOwner]);

	const handleAutoCompact = useCallback(
		(next: boolean) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = autoCompact;
			setAutoCompact(next);
			persist(
				setContextAutoCompact(target, next),
				isCurrent,
				"auto-compact",
				() => setAutoCompact(previous)
			);
		},
		[autoCompact, target, captureOwner]
	);

	const handleCompactOnCacheExpire = useCallback(
		(next: boolean) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = compactOnCacheExpire;
			setCompactOnCacheExpire(next);
			persist(
				setContextCompactOnCacheExpire(target, next),
				isCurrent,
				"compact-on-cache-expire",
				() => setCompactOnCacheExpire(previous)
			);
		},
		[compactOnCacheExpire, target, captureOwner]
	);

	const handleCompactModel = useCallback(
		(next: SideModelConfig) => {
			const isCurrent = captureOwner();
			if (!isCurrent) {
				return;
			}
			const previous = compactModel;
			setCompactModel(next);
			persist(
				setContextCompactConfig(target, next),
				isCurrent,
				"the summarizer model",
				() => setCompactModel(previous)
			);
		},
		[compactModel, target, captureOwner]
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
			caption="Off by default. With a budget set, Ryu keeps the newest turns that fit and always keeps the system prompt (your instructions, recalled memory and skills), which the engine's own overflow handling can otherwise drop. Everything below the budget is ignored while it is off, unless a scoped override (context.max-tokens.local or context.max-tokens.engine.<id>) is set."
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
						<SelectTrigger className="h-9 w-full" id="context-budget">
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
					{scopedOverrides.map((override) => (
						<p className="text-muted-foreground text-xs" key={override.key}>
							{tl("Scoped override set: {key} = {value}. {effect}", {
								key: override.key,
								value: override.value,
								effect: scopedOverrideEffect(override, budget),
							})}
						</p>
					))}
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
							{tl(
								"Minimum {min}. Below that there is no room left for history and every turn would be sent with just your last message.",
								{ min: formatNumber(CONTEXT_MIN_BUDGET_TOKENS) }
							)}
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
						{historyCeiling === null
							? tl(
									"Held back from the budget so the answer has room. Applies once a budget is set."
								)
							: tl(
									"Held back from the budget so the answer has room. Leaves at most {tokens} tokens for history, less once your system prompt, recalled memory and skills are counted.",
									{ tokens: formatNumber(historyCeiling) }
								)}
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
				{autoCompact && !off ? (
					<>
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor="context-compact-on-cache-expire">
								Also compact when the prompt cache expires
							</Label>
							<Switch
								checked={compactOnCacheExpire}
								id="context-compact-on-cache-expire"
								onCheckedChange={handleCompactOnCacheExpire}
							/>
						</div>
						<p className="text-muted-foreground text-xs">
							Anthropic keeps a conversation's prompt cached for about 5 minutes
							after each turn, OpenAI for about 30. Once it has expired, the
							next message is sent in full anyway, so Ryu summarizes more of the
							older history then and the agent starts that turn from the summary
							instead of reopening its previous session. Applies to agent
							conversations; providers that publish no cache expiry are never
							compacted early.
						</p>
					</>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
