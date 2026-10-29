import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { MemoryAdvancedPanel } from "./memory-advanced.tsx";
import { MemoryLibraryPanel } from "./memory-library.tsx";

const KEYS = {
	autoRecall: "auto-recall-enabled",
	topK: "auto-recall-top-k",
	contextBudget: "context.max-tokens",
	contextReserve: "context.max-output-tokens",
	autoCompact: "context.auto-compact",
	skills: "skills-disclosure",
	ranker: "tools.active_ranker",
} as const;

const ROWS = [
	"autoRecall",
	"topK",
	"contextBudget",
	"contextReserve",
	"autoCompact",
	"skills",
	"ranker",
] as const;

type RowId = (typeof ROWS)[number];
type ContextBudget = "off" | "auto" | `tokens:${number}`;
type Ranker = "needle2" | "bm25" | "semantic";

interface MemoryPreferences {
	autoCompact: boolean;
	autoRecall: boolean;
	contextBudget: ContextBudget;
	contextReserve: number;
	ranker: Ranker;
	skills: boolean;
	topK: number;
}

const preferenceWireSchema = z.object({
	value: z.string().nullable().catch(null),
});
type PreferenceWire = z.infer<typeof preferenceWireSchema>;

interface PreferenceWrite {
	key: string;
	value: string;
}

interface SaveIntent {
	label: string;
	next: Partial<MemoryPreferences>;
	previous: Partial<MemoryPreferences>;
	writes: readonly PreferenceWrite[];
}

const DEFAULTS: MemoryPreferences = {
	autoRecall: true,
	topK: 5,
	contextBudget: "off",
	contextReserve: 1024,
	autoCompact: false,
	skills: true,
	ranker: "needle2",
};

const TOP_K_MIN = 1;
const TOP_K_MAX = 50;
const BUDGET_MIN = 2048;
const BUDGET_MAX = 2_000_000;
const RESERVE_MIN = 128;
const RESERVE_MAX = 32_768;
const RANKERS: readonly Ranker[] = ["needle2", "bm25", "semantic"];

function raw(wire: PreferenceWire): string | null {
	return wire.value;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
	if (value === null) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "on", "yes"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "off", "no"].includes(normalized)) {
		return false;
	}
	return fallback;
}

function parseAutoRecall(value: string | null): boolean {
	if (value === null) {
		return true;
	}
	return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

function parseContextBudget(value: string | null): ContextBudget {
	const normalized = (value ?? "").trim().toLowerCase();
	if (normalized === "" || normalized === "0" || normalized === "off") {
		return "off";
	}
	if (normalized === "auto") {
		return "auto";
	}
	if (!/^\+?\d+$/.test(normalized)) {
		return "off";
	}
	const parsed = Number.parseInt(normalized, 10);
	return Number.isFinite(parsed) && parsed > 0 ? `tokens:${parsed}` : "off";
}

function parsePreferences(
	values: ReadonlyMap<string, string | null>
): MemoryPreferences {
	const topKRaw = values.get(KEYS.topK);
	const topKParsed =
		topKRaw && /^\+?\d+$/.test(topKRaw.trim())
			? Number.parseInt(topKRaw.trim(), 10)
			: Number.NaN;
	const reserveRaw = values.get(KEYS.contextReserve);
	const reserveParsed =
		reserveRaw && /^\+?\d+$/.test(reserveRaw.trim())
			? Number.parseInt(reserveRaw.trim(), 10)
			: Number.NaN;
	const rankerRaw = values.get(KEYS.ranker)?.trim().toLowerCase();
	return {
		autoRecall: parseAutoRecall(values.get(KEYS.autoRecall) ?? null),
		topK:
			Number.isFinite(topKParsed) && topKParsed > 0
				? topKParsed
				: DEFAULTS.topK,
		contextBudget: parseContextBudget(values.get(KEYS.contextBudget) ?? null),
		contextReserve:
			Number.isFinite(reserveParsed) && reserveParsed >= 0
				? reserveParsed
				: DEFAULTS.contextReserve,
		autoCompact: parseBoolean(values.get(KEYS.autoCompact) ?? null, false),
		skills:
			(values.get(KEYS.skills) ?? "progressive").trim().toLowerCase() !==
			"full",
		ranker:
			rankerRaw === "bm25" || rankerRaw === "semantic" ? rankerRaw : "needle2",
	};
}

function contextBudgetValue(budget: ContextBudget): string {
	if (budget === "off" || budget === "auto") {
		return budget;
	}
	const tokens = Number.parseInt(budget.slice("tokens:".length), 10);
	return String(Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, tokens)));
}

function displayBudget(budget: ContextBudget): string {
	if (budget === "off" || budget === "auto") {
		return budget === "off" ? "Off" : "Auto";
	}
	return `${Number.parseInt(budget.slice("tokens:".length), 10).toLocaleString()} tokens`;
}

function parseWholeNumber(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\+?\d+$/.test(trimmed)) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function wireValue(preferences: MemoryPreferences, field: RowId): string {
	switch (field) {
		case "autoRecall":
			return String(preferences.autoRecall);
		case "topK":
			return String(preferences.topK);
		case "contextBudget":
			return contextBudgetValue(preferences.contextBudget);
		case "contextReserve":
			return String(preferences.contextReserve);
		case "autoCompact":
			return String(preferences.autoCompact);
		case "skills":
			return preferences.skills ? "progressive" : "full";
		case "ranker":
			return preferences.ranker;
	}
}

/** Core-backed memory and conversation-context preferences with readback. */
export function MemoryPanel({
	active,
	onEditingChange,
	onNavigationOwnershipChange,
}: {
	active: boolean;
	onEditingChange: (editing: boolean) => void;
	onNavigationOwnershipChange: (owned: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [advanced, setAdvanced] = useState(false);
	const [library, setLibrary] = useState(false);
	const [preferences, setPreferences] = useState(DEFAULTS);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
		"loading"
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [retryIntent, setRetryIntent] = useState<SaveIntent | null>(null);
	const [editing, setEditing] = useState<RowId | null>(null);
	const [draft, setDraft] = useState("");
	const editingRef = useRef(false);
	const selected = ROWS[selectedIndex] ?? ROWS[0];

	const loadPreferences = useCallback(async () => {
		setLoadState("loading");
		setError(null);
		setNotice(null);
		setRetryIntent(null);
		try {
			const pairs = await Promise.all(
				Object.values(KEYS).map(async (key) => {
					const wire = preferenceWireSchema.parse(
						await request(
							target,
							`/api/preferences/${key}`,
							{},
							appResponseValueSchema
						)
					);
					return [key, raw(wire)] as const;
				})
			);
			setPreferences(parsePreferences(new Map(pairs)));
			setLoadState("ready");
		} catch (loadError) {
			setLoadState("error");
			setError(
				`Couldn't load Memory preferences: ${loadError instanceof Error ? loadError.message : String(loadError)}. Press r to retry.`
			);
		}
	}, [target]);

	useEffect(() => {
		if (!active) {
			return;
		}
		onNavigationOwnershipChange(true);
		void loadPreferences();
		return () => {
			editingRef.current = false;
			onEditingChange(false);
			onNavigationOwnershipChange(false);
		};
	}, [active, loadPreferences, onEditingChange, onNavigationOwnershipChange]);

	const saveIntent = useCallback(
		async (intent: SaveIntent) => {
			if (busy) {
				return;
			}
			setBusy(true);
			setError(null);
			setNotice(null);
			setRetryIntent(intent);
			try {
				for (const write of intent.writes) {
					await request(
						target,
						`/api/preferences/${write.key}`,
						{
							method: "PUT",
							body: { value: write.value },
						},
						appResponseValueSchema
					);
				}
				for (const write of intent.writes) {
					const current = preferenceWireSchema.parse(
						await request(
							target,
							`/api/preferences/${write.key}`,
							{},
							appResponseValueSchema
						)
					);
					if (raw(current) !== write.value) {
						throw new Error(`Core did not confirm ${write.key}.`);
					}
				}
				setPreferences((current) => ({ ...current, ...intent.next }));
				setRetryIntent(null);
				setNotice("Saved and confirmed from Core.");
			} catch (saveError) {
				setPreferences((current) => ({ ...current, ...intent.previous }));
				setRetryIntent(intent);
				setError(
					`Couldn't save ${intent.label}: ${saveError instanceof Error ? saveError.message : String(saveError)}. Press r to retry.`
				);
			} finally {
				setBusy(false);
			}
		},
		[busy, target]
	);

	const saveField = useCallback(
		<K extends RowId>(field: K, next: MemoryPreferences[K], label: string) => {
			const previousValue = preferences[field];
			const nextPreferences: MemoryPreferences = {
				...preferences,
				[field]: next,
			};
			setPreferences(nextPreferences);
			void saveIntent({
				label,
				next: { [field]: next },
				previous: { [field]: previousValue },
				writes: [
					{ key: KEYS[field], value: wireValue(nextPreferences, field) },
				],
			});
		},
		[preferences, saveIntent]
	);

	const openEditor = useCallback(
		(row: "topK" | "contextBudget" | "contextReserve") => {
			if (row === "topK" && !preferences.autoRecall) {
				setNotice("Turn on auto-recall before changing the snippet limit.");
				return;
			}
			if (
				(row === "contextReserve" || row === "contextBudget") &&
				preferences.contextBudget === "off" &&
				row === "contextReserve"
			) {
				setNotice("Set a context budget before editing its reply reserve.");
				return;
			}
			// TextInput starts its cursor at the beginning of a controlled value, so a
			// blank draft makes this an intentional replacement instead of prefixing.
			setDraft("");
			editingRef.current = true;
			setEditing(row);
			onEditingChange(true);
			setError(null);
			setNotice(null);
		},
		[onEditingChange, preferences]
	);

	const commitEditor = useCallback(
		(value: string) => {
			if (!editing) {
				return;
			}
			if (editing === "contextBudget") {
				const normalized = value.trim().toLowerCase();
				let nextBudget: ContextBudget | null = null;
				if (normalized === "off" || normalized === "auto") {
					nextBudget = normalized;
				} else {
					const parsed = parseWholeNumber(normalized);
					if (parsed !== null && parsed > 0) {
						nextBudget = `tokens:${Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, parsed))}`;
					}
				}
				if (nextBudget === null) {
					setError(
						`Enter Off, Auto, or a whole-number context budget from ${BUDGET_MIN.toLocaleString()} to ${BUDGET_MAX.toLocaleString()}.`
					);
					return;
				}
				editingRef.current = false;
				setEditing(null);
				onEditingChange(false);
				saveField("contextBudget", nextBudget, "the context budget");
				return;
			}
			const parsed = parseWholeNumber(value);
			if (parsed === null) {
				setError("Enter a whole number.");
				return;
			}
			editingRef.current = false;
			setEditing(null);
			onEditingChange(false);
			if (editing === "topK") {
				saveField(
					"topK",
					Math.min(TOP_K_MAX, Math.max(TOP_K_MIN, parsed)),
					"the recall limit"
				);
			} else {
				saveField(
					"contextReserve",
					Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, parsed)),
					"the reply reserve"
				);
			}
		},
		[editing, onEditingChange, saveField]
	);

	const retry = useCallback(() => {
		if (busy) {
			return;
		}
		if (loadState === "error") {
			void loadPreferences();
			return;
		}
		if (retryIntent) {
			void saveIntent(retryIntent);
			return;
		}
		void loadPreferences();
	}, [busy, loadPreferences, loadState, retryIntent, saveIntent]);

	const toggleSelected = useCallback(() => {
		if (selected === "autoRecall") {
			saveField("autoRecall", !preferences.autoRecall, "auto-recall");
		} else if (selected === "autoCompact") {
			if (preferences.contextBudget === "off") {
				setNotice(
					"Set a context budget first; auto-compact is inactive while the budget is off."
				);
				return;
			}
			saveField("autoCompact", !preferences.autoCompact, "auto-compact");
		} else if (selected === "skills") {
			saveField("skills", !preferences.skills, "skill loading");
		}
	}, [preferences, saveField, selected]);

	const cycleRanker = useCallback(
		(direction: -1 | 1) => {
			const current = RANKERS.indexOf(preferences.ranker);
			const next =
				RANKERS[(current + direction + RANKERS.length) % RANKERS.length] ??
				"needle2";
			saveField("ranker", next, "search ranking");
		},
		[preferences.ranker, saveField]
	);

	const cycleBudget = useCallback(
		(direction: -1 | 1) => {
			const standardChoices: ContextBudget[] = [
				"off",
				"auto",
				"tokens:4096",
				"tokens:8192",
				"tokens:16384",
				"tokens:32768",
				"tokens:65536",
				"tokens:131072",
			];
			const choices = standardChoices.includes(preferences.contextBudget)
				? standardChoices
				: [
						...standardChoices.slice(0, 2),
						preferences.contextBudget,
						...standardChoices.slice(2),
					];
			const current = choices.indexOf(preferences.contextBudget);
			const next =
				choices[(current + direction + choices.length) % choices.length] ??
				"off";
			saveField("contextBudget", next, "the context budget");
		},
		[preferences.contextBudget, saveField]
	);

	useKeyboard((key) => {
		if (!active || advanced || library || busy || editingRef.current) {
			return;
		}
		if (key.name === "l") {
			setLibrary(true);
			return;
		}
		if (key.name === "m") {
			setAdvanced(true);
			return;
		}
		if (key.name === "up") {
			setSelectedIndex((index) => Math.max(0, index - 1));
			return;
		}
		if (key.name === "down") {
			setSelectedIndex((index) => Math.min(ROWS.length - 1, index + 1));
			return;
		}
		if (key.name === "r") {
			retry();
			return;
		}
		if (loadState !== "ready") {
			return;
		}
		if (selected === "ranker" && key.name === "left") {
			cycleRanker(-1);
			return;
		}
		if (selected === "ranker" && key.name === "right") {
			cycleRanker(1);
			return;
		}
		if (selected === "contextBudget" && key.name === "left") {
			cycleBudget(-1);
			return;
		}
		if (selected === "contextBudget" && key.name === "right") {
			cycleBudget(1);
			return;
		}
		if (
			(selected === "topK" ||
				selected === "contextBudget" ||
				selected === "contextReserve") &&
			key.name === "e"
		) {
			openEditor(selected);
			return;
		}
		if (key.name === "return" || key.name === " " || key.name === "space") {
			toggleSelected();
		}
	});

	if (library) {
		return (
			<MemoryLibraryPanel
				active={active}
				onBack={() => setLibrary(false)}
				onEditingChange={onEditingChange}
			/>
		);
	}
	if (advanced) {
		return (
			<MemoryAdvancedPanel
				active={active}
				onBack={() => setAdvanced(false)}
				onEditingChange={onEditingChange}
			/>
		);
	}
	const color = theme.colors;
	const labels = {
		autoRecall: {
			label: "Automatically recall context",
			value: preferences.autoRecall ? "ON" : "OFF",
			description:
				"Core adds relevant saved memories and earlier chats before a reply.",
		},
		topK: {
			label: "Snippets per reply",
			value: String(preferences.topK),
			description: preferences.autoRecall
				? `Choose ${TOP_K_MIN}–${TOP_K_MAX} recalled snippets.`
				: "Auto-recall is off; turn it on before changing this limit.",
		},
		contextBudget: {
			label: "Conversation context budget",
			value: displayBudget(preferences.contextBudget),
			description:
				"Off sends the full conversation; Auto needs a local model context size.",
		},
		contextReserve: {
			label: "Reply token reserve",
			value: String(preferences.contextReserve),
			description: `Applies with a context budget; editable range ${RESERVE_MIN}–${RESERVE_MAX}.`,
		},
		autoCompact: {
			label: "Summarize older turns",
			value: preferences.autoCompact ? "ON" : "OFF",
			description:
				"Uses a summarizer model when turns fall outside a context budget.",
		},
		skills: {
			label: "Load skills on demand",
			value: preferences.skills
				? "ON · progressive"
				: "OFF · full instructions",
			description:
				"Controls whether agents load complete skill instructions only when relevant.",
		},
		ranker: {
			label: "Tool and skill search ranking",
			value: preferences.ranker,
			description:
				"Needle 2, keyword BM25, or embeddings-based semantic search.",
		},
	} satisfies Record<
		RowId,
		{ label: string; value: string; description: string }
	>;
	return (
		<Card
			subtitle="Node-wide Core preferences used by chat"
			title="Memory and context"
		>
			{loadState === "loading" ? (
				<text fg={color.mutedForeground}>Loading Core memory preferences…</text>
			) : null}
			{ROWS.map((row, index) => {
				const isSelected = selectedIndex === index;
				const rowInfo = labels[row];
				return (
					<box flexDirection="column" flexShrink={0} key={row} marginTop={1}>
						<box flexDirection="row" gap={1}>
							<text fg={isSelected ? color.primary : color.foreground}>
								{isSelected ? "›" : " "}
							</text>
							<text fg={isSelected ? color.primary : color.foreground}>
								{isSelected ? <b>{rowInfo.label}</b> : rowInfo.label}
							</text>
							{editing === row ? null : (
								<text fg={color.mutedForeground}>{rowInfo.value}</text>
							)}
						</box>
						{editing === row ? (
							<TextInput
								bordered={false}
								label={rowInfo.label}
								onChange={setDraft}
								onSubmit={commitEditor}
								placeholder={
									row === "contextBudget"
										? "off, auto, or token count"
										: "Whole number"
								}
								value={draft}
								width={36}
							/>
						) : null}
					</box>
				);
			})}
			<box marginTop={1}>
				<text fg={color.mutedForeground}>
					{labels[ROWS[selectedIndex] ?? "autoRecall"].description}
				</text>
			</box>
			{error ? (
				<box marginTop={1}>
					<text fg={color.error}>{error}</text>
				</box>
			) : null}
			{notice ? (
				<box marginTop={1}>
					<text fg={color.warning}>{notice}</text>
				</box>
			) : null}
			{busy ? (
				<box marginTop={1}>
					<text fg={color.mutedForeground}>Saving to Core and confirming…</text>
				</box>
			) : null}
			<box marginTop={1}>
				<text fg={color.mutedForeground}>
					{editing
						? "Type value · Enter save · Esc close settings"
						: "↑↓ move rows · j/k change Settings panels · Enter toggle · e edit numbers · ←/→ choose budget or ranking · r retry / reload"}
				</text>
			</box>
			<box marginTop={1}>
				<text fg={color.mutedForeground}>
					m · Summarizer model, effort, cross-session and sensitive-topic
					consent. l · Memory library: search, add, edit, and delete.
				</text>
			</box>
		</Card>
	);
}
