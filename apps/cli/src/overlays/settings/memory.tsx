import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { MemoryAdvancedPanel } from "./memory-advanced.tsx";
import { MemoryLibraryPanel } from "./memory-library.tsx";
import {
	BUDGET_MAX,
	BUDGET_MIN,
	type ContextBudget,
	DEFAULTS,
	KEYS,
	type MemoryPreferences,
	parsePreferences,
	parseWholeNumber,
	preferenceWireSchema,
	RANKERS,
	RESERVE_MAX,
	RESERVE_MIN,
	ROWS,
	type RowId,
	raw,
	type SaveIntent,
	TOP_K_MAX,
	TOP_K_MIN,
	wireValue,
} from "./memory-preferences.ts";
import { memoryRowLabels } from "./memory-row-labels.ts";

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
				tf("Couldn't load Memory preferences: {error}. Press r to retry.", {
					error:
						loadError instanceof Error ? loadError.message : String(loadError),
				})
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
					tf("Couldn't save {label}: {error}. Press r to retry.", {
						label: intent.label,
						error:
							saveError instanceof Error
								? saveError.message
								: String(saveError),
					})
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
						tf(
							"Enter Off, Auto, or a whole-number context budget from {min} to {max}.",
							{
								min: BUDGET_MIN.toLocaleString(),
								max: BUDGET_MAX.toLocaleString(),
							}
						)
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
	const labels = memoryRowLabels(preferences);
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
