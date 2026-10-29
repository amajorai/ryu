/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { ApiError, request } from "@ryuhq/core-client/client";
import {
	DEFAULT_USER_PERSONALIZATION,
	parseUserPersonalization,
	USER_PERSONALIZATION_PREF_KEY,
	type UserPersonalization,
} from "@ryuhq/core-client/personalization";
import { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { corePreferenceResponseSchema } from "../../core/settings-response-codecs.ts";
import { ConfirmPrompt } from "../../ui/ConfirmPrompt.tsx";
import { aboutYouCacheWarning } from "./prompt-cache-warning.ts";

const FIELDS: Array<{ key: keyof UserPersonalization; label: string }> = [
	{ key: "nickname", label: "Nickname" },
	{ key: "occupation", label: "Occupation" },
	{ key: "aboutYou", label: "About you" },
	{ key: "aboutOrganization", label: "About your organization" },
];

/** Whether any field differs from the stored value. Exported for unit tests. */
export function personalContextChanged(
	stored: UserPersonalization,
	draft: UserPersonalization
): boolean {
	return FIELDS.some(({ key }) => stored[key] !== draft[key]);
}

export function PersonalContext({
	active,
	onEditingChange,
}: {
	active: boolean;
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [draft, setDraft] = useState(DEFAULT_USER_PERSONALIZATION);
	const [stored, setStored] = useState(DEFAULT_USER_PERSONALIZATION);
	const [confirming, setConfirming] = useState(false);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [editing, setEditing] = useState(false);
	const [field, setField] = useState(0);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const path = `/api/preferences/${USER_PERSONALIZATION_PREF_KEY}`;
	const read = useCallback(
		async (signal?: AbortSignal) => {
			try {
				return parseUserPersonalization(
					(
						await request(
							target,
							path,
							{ signal },
							corePreferenceResponseSchema
						)
					).value
				);
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) {
					return { ...DEFAULT_USER_PERSONALIZATION };
				}
				throw error;
			}
		},
		[path, target]
	);
	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setFailed(false);
			try {
				const value = await read(signal);
				if (!signal?.aborted) {
					setDraft(value);
					setStored(value);
				}
			} catch (error) {
				if (!signal?.aborted) {
					setFailed(true);
					setMessage(
						`Could not load personal context: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			} finally {
				if (!signal?.aborted) {
					setLoading(false);
				}
			}
		},
		[read]
	);
	useEffect(() => {
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [load]);
	const edit = (next: boolean) => {
		setEditing(next);
		onEditingChange(next);
	};
	const save = async () => {
		if (busy || failed || loading) {
			return;
		}
		setBusy(true);
		setMessage("");
		try {
			await request(
				target,
				path,
				{
					method: "PUT",
					body: { value: JSON.stringify(draft) },
				},
				appResponseValueSchema
			);
			const saved = await read();
			if (JSON.stringify(saved) !== JSON.stringify(draft)) {
				throw new Error("Saved context did not match readback.");
			}
			setStored(saved);
			setMessage("Personal context saved and confirmed.");
			edit(false);
		} catch (error) {
			setMessage(
				`Could not save personal context: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			setBusy(false);
		}
	};
	// About you is folded into every owner thread's system prompt, so a changed
	// value asks before it resets the prompt cache. An unchanged save does not.
	const requestSave = () => {
		if (busy || failed || loading) {
			return;
		}
		if (personalContextChanged(stored, draft)) {
			setConfirming(true);
			return;
		}
		void save();
	};
	const warning = aboutYouCacheWarning();
	useKeyboard((key) => {
		// While the prompt is open it owns y, n, Esc, Enter and Tab.
		if (!active || busy || confirming) {
			return;
		}
		if (editing) {
			if (key.name === "tab") {
				setField((index) => (index + 1) % FIELDS.length);
			} else if (key.name === "return") {
				requestSave();
			}
			return;
		}
		if (key.name === "p" && !loading && !failed) {
			edit(true);
		}
		if (key.name === "r" && failed) {
			void load();
		}
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={theme.colors.foreground}>
				<b>Personal context</b>
			</text>
			{loading ? <text>Loading personal context…</text> : null}
			{loading || failed
				? null
				: FIELDS.map((item, index) => (
						<box flexDirection="row" gap={1} key={item.key}>
							<text fg={theme.colors.mutedForeground}>{item.label}</text>
							{editing ? (
								<input
									focused={active && !confirming && field === index}
									onInput={(value: string) =>
										setDraft((current) => ({ ...current, [item.key]: value }))
									}
									value={draft[item.key]}
								/>
							) : (
								<text>{draft[item.key] || "—"}</text>
							)}
						</box>
					))}
			<text
				fg={
					message.startsWith("Could not")
						? theme.colors.error
						: theme.colors.success
				}
			>
				{message}
			</text>
			{confirming ? (
				<ConfirmPrompt
					active={active}
					confirmLabel="Apply now"
					consequence={warning.description}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						void save();
					}}
					title={warning.title}
				/>
			) : (
				<text fg={theme.colors.mutedForeground}>
					{failed
						? "r retry personal context"
						: editing
							? "Tab next field · Enter save · click Cancel to discard"
							: "p edit personal context"}
				</text>
			)}
			{editing && !confirming ? (
				<box
					onMouseDown={() => {
						edit(false);
						void load();
					}}
				>
					<text fg={theme.colors.primary}>Cancel personal context</text>
				</box>
			) : null}
		</box>
	);
}
