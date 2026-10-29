/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { fetchPiCatalog } from "@ryuhq/core-client/pi-config";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import {
	readMemoryConsent,
	writeMemoryConsent,
} from "../../core/memoryConsent.ts";
import {
	coreMemorySettingsResponseSchema,
	corePreferenceResponseSchema,
} from "../../core/settings-response-codecs.ts";
import { tf } from "../../i18n/translate.ts";

const MODEL = "context.compact-model";
const EFFORT = "context.compact-effort";
type Intent =
	| { kind: "model" | "effort"; value: string }
	| { kind: "sensitive" | "longTerm"; value: boolean };

export function MemoryAdvancedPanel({
	active,
	onBack,
	onEditingChange,
}: {
	active: boolean;
	onBack: () => void;
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const { colors } = useTheme();
	const [row, setRow] = useState(0);
	const [model, setModel] = useState("");
	const [effort, setEffort] = useState("");
	const [models, setModels] = useState<string[]>([]);
	const [efforts, setEfforts] = useState<string[]>([""]);
	const [sensitive, setSensitive] = useState(false);
	const [consentReady, setConsentReady] = useState(false);
	const [longTerm, setLongTerm] = useState(readMemoryConsent);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [consentError, setConsentError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [retry, setRetry] = useState<Intent | null>(null);
	const load = useCallback(async () => {
		setReady(false);
		setError(null);
		setConsentReady(false);
		setSensitive(false);
		setConsentError(null);
		const consent = request(
			target,
			"/api/memory/settings",
			{},
			coreMemorySettingsResponseSchema
		)
			.then((value) => {
				setSensitive(value.include_sensitive_topics === true);
				setConsentReady(true);
			})
			.catch((cause) => {
				setConsentError(
					tf("Sensitive-topic consent unavailable: {error}", {
						error: cause instanceof Error ? cause.message : String(cause),
					})
				);
			});
		try {
			const [modelWire, effortWire, catalog] = await Promise.all([
				request(
					target,
					`/api/preferences/${MODEL}`,
					{},
					corePreferenceResponseSchema
				),
				request(
					target,
					`/api/preferences/${EFFORT}`,
					{},
					corePreferenceResponseSchema
				),
				fetchPiCatalog(target),
			]);
			setModel(memoryPreferenceValueSchema.parse(modelWire).value);
			setEffort(memoryPreferenceValueSchema.parse(effortWire).value);
			setModels([
				...new Set(
					(catalog.providers ?? []).flatMap(
						(provider) => provider.suggestedModels
					)
				),
			]);
			setEfforts(["", ...(catalog.thinkingLevels ?? [])]);
			setReady(true);
		} catch (cause) {
			setError(
				tf("Couldn't load summarizer: {error}. Press r to retry.", {
					error: cause instanceof Error ? cause.message : String(cause),
				})
			);
		}
		await consent;
	}, [target]);
	useEffect(() => {
		if (active) {
			void load();
		}
	}, [active, load]);
	useEffect(() => () => onEditingChange(false), [onEditingChange]);
	const save = useCallback(
		async (intent: Intent) => {
			if (busy) {
				return;
			}
			setBusy(true);
			setRetry(intent);
			setError(null);
			setNotice(null);
			try {
				if (intent.kind === "longTerm") {
					writeMemoryConsent(intent.value);
					setLongTerm(readMemoryConsent());
				} else if (intent.kind === "sensitive") {
					await request(
						target,
						"/api/memory/settings",
						{
							method: "PUT",
							body: { include_sensitive_topics: intent.value },
						},
						appResponseValueSchema
					);
					const actual = await request(
						target,
						"/api/memory/settings",
						{},
						coreMemorySettingsResponseSchema
					);
					if (actual.include_sensitive_topics !== intent.value) {
						throw new Error("Core did not confirm sensitive-topic consent.");
					}
					setSensitive(actual.include_sensitive_topics);
				} else {
					const key = intent.kind === "model" ? MODEL : EFFORT;
					await request(
						target,
						`/api/preferences/${key}`,
						{
							method: "PUT",
							body: { value: intent.value },
						},
						appResponseValueSchema
					);
					const actual = await request(
						target,
						`/api/preferences/${key}`,
						{},
						corePreferenceResponseSchema
					);
					if (actual.value !== intent.value) {
						throw new Error("Core did not confirm the saved value.");
					}
					if (intent.kind === "model") {
						setModel(intent.value);
					} else {
						setEffort(intent.value);
					}
				}
				setRetry(null);
				setNotice("Saved and confirmed.");
			} catch (cause) {
				if (intent.kind === "sensitive") {
					setSensitive(false);
					setConsentReady(false);
				}
				setError(
					tf("Couldn't save: {error}. Press r to retry.", {
						error: cause instanceof Error ? cause.message : String(cause),
					})
				);
			} finally {
				setBusy(false);
			}
		},
		[busy, target]
	);
	useKeyboard((key) => {
		if (!active || busy || editing) {
			return;
		}
		if (key.name === "m") {
			onBack();
			return;
		}
		if (key.name === "up") {
			setRow((index) => Math.max(0, index - 1));
			return;
		}
		if (key.name === "down") {
			setRow((index) => Math.min(3, index + 1));
			return;
		}
		if (key.name === "r") {
			if (retry) {
				void save(retry);
			} else {
				void load();
			}
			return;
		}
		if (row === 2 && key.name === "return") {
			void save({ kind: "longTerm", value: !longTerm });
			return;
		}
		if (row === 3 && key.name === "return") {
			if (!consentReady) {
				setError(
					"A verified user with memory write permission is required. Press r to reload after signing in."
				);
				return;
			}
			void save({ kind: "sensitive", value: !sensitive });
			return;
		}
		if (!ready) {
			return;
		}
		if (row === 0 && key.name === "e") {
			setDraft("");
			setEditing(true);
			onEditingChange(true);
			return;
		}
		if (
			(row === 0 || row === 1) &&
			(key.name === "left" || key.name === "right")
		) {
			const current = row === 0 ? model : effort;
			const choices = [
				...new Set([
					"",
					...(row === 0 ? models : efforts),
					...(current ? [current] : []),
				]),
			];
			const index = choices.indexOf(current);
			const value =
				choices[
					(index + (key.name === "right" ? 1 : -1) + choices.length) %
						choices.length
				] ?? "";
			void save({ kind: row === 0 ? "model" : "effort", value });
		}
	});
	const labels = [
		"Summarizer model",
		"Summarizer thinking / effort",
		"Cross-session memory",
		"Include sensitive topics",
	];
	const values = [
		model || "Use default model",
		effort || "Provider default",
		longTerm ? "ON" : "OFF",
		consentReady ? (sensitive ? "ON" : "OFF") : "Unavailable · OFF",
	];
	const descriptions = [
		"Blank inherits the node default, then the chat model. e enters a custom routable model.",
		"Choices come from this node's model catalog.",
		"CLI consent applies to subsequent chat requests and survives restarts.",
		"Core verifies the user and memory permissions. Existing sensitive memories are hidden while off.",
	];
	return (
		<Card
			subtitle="Core settings and CLI chat consent"
			title="Memory models and consent"
		>
			{labels.map((label, index) => (
				<box flexDirection="column" key={label} marginTop={1}>
					<text fg={row === index ? colors.primary : colors.foreground}>
						{row === index ? "› " : "  "}
						{label}: {values[index]}
					</text>
					<text fg={colors.mutedForeground}>{descriptions[index]}</text>
				</box>
			))}
			{editing ? (
				<TextInput
					label="Custom summarizer model"
					onChange={setDraft}
					onSubmit={(value) => {
						if (
							value.trim().length > 512 ||
							value.includes(String.fromCharCode(0)) ||
							/[\r\n]/.test(value)
						) {
							setError("Enter a single model ID of at most 512 characters.");
							return;
						}
						setEditing(false);
						onEditingChange(false);
						void save({ kind: "model", value: value.trim() });
					}}
					placeholder="Blank uses default"
					value={draft}
					width={48}
				/>
			) : null}
			{ready ? null : (
				<text fg={colors.mutedForeground}>
					Summarizer catalog unavailable or loading.
				</text>
			)}
			{consentError ? <text fg={colors.warning}>{consentError}</text> : null}
			{error ? <text fg={colors.error}>{error}</text> : null}
			{notice ? <text fg={colors.success}>{notice}</text> : null}
			<text fg={colors.mutedForeground}>
				{busy
					? "Saving and confirming…"
					: "↑↓ rows · ←/→ model / effort · e custom model · Enter consent · r retry · m back · j/k Settings panels"}
			</text>
		</Card>
	);
}

const memoryPreferenceValueSchema = z.object({ value: z.string().catch("") });
