/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { ApiError, type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { nativeErrorMessage as errorMessage } from "../../core/native-errors.ts";
import {
	autoUpdatePreferenceSchema,
	autoUpdateSettingSchema,
} from "../../core/self-update.ts";
import { tf, tr } from "../../i18n/translate.ts";

const AUTO_UPDATE_KEY = "auto-updates";
const DEFAULT_ENABLED = true;

type PreferenceWire = z.infer<typeof autoUpdatePreferenceSchema>;
function enabledFromRaw(raw: PreferenceWire["value"]): boolean {
	if (raw === null) {
		return DEFAULT_ENABLED;
	}
	try {
		const parsed = autoUpdateSettingSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data.enabled : DEFAULT_ENABLED;
	} catch {
		return DEFAULT_ENABLED;
	}
}
function requestUpdatePreference(target: ApiTarget, path: string) {
	return request(target, path, {}, appResponseValueSchema).then((raw) =>
		autoUpdatePreferenceSchema.parse(raw)
	);
}

/** CLI automatic updates use Core's shared preference and official release checksums. */
export function UpdatesPanel() {
	const { target } = useCore();
	const theme = useTheme();
	const [enabled, setEnabled] = useState(DEFAULT_ENABLED);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		setNotice(null);
		try {
			const wire = await requestUpdatePreference(
				target,
				`/api/preferences/${AUTO_UPDATE_KEY}`
			);
			setEnabled(enabledFromRaw(wire.value));
		} catch (loadError) {
			if (loadError instanceof ApiError && loadError.status === 404) {
				setEnabled(DEFAULT_ENABLED);
			} else {
				setError(
					tf("Couldn't load update preferences: {error}. Press r to reload.", {
						error: errorMessage(loadError),
					})
				);
			}
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = useCallback(async () => {
		if (loading || busy || error) {
			return;
		}
		const next = !enabled;
		const value = JSON.stringify({ enabled: next });
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await request(
				target,
				`/api/preferences/${AUTO_UPDATE_KEY}`,
				{
					method: "PUT",
					body: { value },
				},
				appResponseValueSchema
			);
			const confirmed = await requestUpdatePreference(
				target,
				`/api/preferences/${AUTO_UPDATE_KEY}`
			);
			if (confirmed.value !== value) {
				throw new Error("Core did not confirm the saved preference.");
			}
			setEnabled(next);
			setNotice("Saved and confirmed from Core.");
		} catch (saveError) {
			setError(
				tf(
					"Couldn't save the update preference: {error}. Press r to reload, then try again.",
					{ error: errorMessage(saveError) }
				)
			);
		} finally {
			setBusy(false);
		}
	}, [busy, enabled, error, loading, target]);

	useKeyboard((key) => {
		if (key.name === "r") {
			if (!busy) {
				void load();
			}
			return;
		}
		if (key.name === "return" || key.name === " " || key.name === "space") {
			void toggle();
		}
	});

	return (
		<Card subtitle="This Core setting is shared with Desktop." title="Updates">
			<text fg={theme.colors.mutedForeground}>
				The CLI checks the matching release channel in the background, verifies
				the official SHA-256 file, and makes the new binary available on your
				next launch.
			</text>
			<box flexDirection="column" marginTop={1}>
				<text fg={theme.colors.primary}>
					<b>
						{tf("Automatic updates: {status}", {
							status: tr(
								loading ? "Loading…" : busy ? "Saving…" : enabled ? "ON" : "OFF"
							),
						})}
					</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					Press Enter or Space to toggle · r to reload
				</text>
			</box>
			{error ? (
				<box marginTop={1}>
					<text fg={theme.colors.error}>{error}</text>
				</box>
			) : null}
			{notice ? (
				<box marginTop={1}>
					<text fg={theme.colors.success}>{notice}</text>
				</box>
			) : null}
		</Card>
	);
}
