/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";
import {
	DEFAULTS,
	type DiagnosticsContentMode,
	errorMessage,
	ONE_HOUR_MS,
	PRIVACY_KEY_ORDER,
	PRIVACY_KEYS,
	type PreferenceWrite,
	type PrivacyPreferences,
	parseBoolean,
	parseContentMode,
	parseExpiry,
	ROWS,
	rawValue,
	requestPrivacyPreference,
	type SaveIntent,
	SUPPORT_DURATION_HOURS,
	SUPPORT_DURATION_INDEX,
	testSpanResponseSchema,
} from "./privacy-preferences.ts";
import { PrivacyFooter, PrivacyRows } from "./privacy-rows.tsx";

/** Core-backed privacy controls for the existing canonical preference keys. */
export function PrivacyPanel({
	active,
	onNavigationOwnershipChange,
	onEditingChange,
}: {
	active: boolean;
	onNavigationOwnershipChange: (owned: boolean) => void;
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [preferences, setPreferences] = useState<PrivacyPreferences>(DEFAULTS);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
		"loading"
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [retryIntent, setRetryIntent] = useState<SaveIntent | null>(null);
	const [editingEndpoint, setEditingEndpoint] = useState(false);
	const [endpointDraft, setEndpointDraft] = useState("");
	const [supportDurationHours, setSupportDurationHours] = useState(1);
	const requestIdRef = useRef(0);
	const editingEndpointRef = useRef(false);
	const selected = ROWS[selectedIndex] ?? ROWS[0];

	const loadPreferences = useCallback(async () => {
		const requestId = ++requestIdRef.current;
		setLoadState("loading");
		setError(null);
		setNotice(null);
		setRetryIntent(null);
		try {
			const values = await Promise.all(
				PRIVACY_KEY_ORDER.map(async (key) => {
					const wire = await requestPrivacyPreference(
						target,
						`/api/preferences/${key}`
					);
					return [key, rawValue(wire)] as const;
				})
			);
			if (requestId !== requestIdRef.current) {
				return;
			}
			const stored = new Map(values);
			setPreferences({
				analytics: parseBoolean(
					stored.get(PRIVACY_KEYS.analytics),
					DEFAULTS.analytics
				),
				community: parseBoolean(
					stored.get(PRIVACY_KEYS.community),
					DEFAULTS.community
				),
				profileActivity: parseBoolean(
					stored.get(PRIVACY_KEYS.profileActivity),
					DEFAULTS.profileActivity
				),
				crashReports: parseBoolean(
					stored.get(PRIVACY_KEYS.crashReports),
					DEFAULTS.crashReports
				),
				diagnosticsExport: parseBoolean(
					stored.get(PRIVACY_KEYS.diagnosticsExport),
					DEFAULTS.diagnosticsExport
				),
				diagnosticsEndpoint:
					stored.get(PRIVACY_KEYS.diagnosticsEndpoint) ??
					DEFAULTS.diagnosticsEndpoint,
				diagnosticsContentMode: parseContentMode(
					stored.get(PRIVACY_KEYS.diagnosticsContentMode)
				),
				supportAccess: parseBoolean(
					stored.get(PRIVACY_KEYS.supportAccess),
					DEFAULTS.supportAccess
				),
				supportExpiry: parseExpiry(
					stored.get(PRIVACY_KEYS.supportExpiry) ?? null
				),
			});
			setLoadState("ready");
		} catch (loadError) {
			if (requestId === requestIdRef.current) {
				setLoadState("error");
				setError(
					tf("Couldn't load privacy preferences: {error}. Press r to retry.", {
						error: errorMessage(loadError),
					})
				);
			}
		}
	}, [target]);

	useEffect(() => {
		if (!active) {
			return;
		}
		onNavigationOwnershipChange(true);
		void loadPreferences();
		return () => {
			requestIdRef.current += 1;
			editingEndpointRef.current = false;
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
					const wire = await requestPrivacyPreference(
						target,
						`/api/preferences/${write.key}`
					);
					if (rawValue(wire) !== write.value) {
						throw new Error(`Core did not confirm ${write.key}.`);
					}
				}
				setPreferences((current) => ({ ...current, ...intent.next }));
				setRetryIntent(null);
				setNotice("Saved and confirmed from Core.");
				if (intent.closeEndpointEditor) {
					editingEndpointRef.current = false;
					setEditingEndpoint(false);
					onEditingChange(false);
				}
			} catch (saveError) {
				setPreferences((current) => ({ ...current, ...intent.previous }));
				setRetryIntent(intent);
				setError(
					tf("Couldn't save {label}: {error}. Press r to retry.", {
						label: intent.label,
						error: errorMessage(saveError),
					})
				);
			} finally {
				setBusy(false);
			}
		},
		[busy, onEditingChange, target]
	);

	const toggleBoolean = useCallback(
		(
			field:
				| "analytics"
				| "community"
				| "profileActivity"
				| "crashReports"
				| "diagnosticsExport"
				| "supportAccess",
			key: string,
			label: string
		) => {
			const previousValue = preferences[field];
			const nextValue = !previousValue;
			const previous: Partial<PrivacyPreferences> = { [field]: previousValue };
			const next: Partial<PrivacyPreferences> = { [field]: nextValue };
			const writes: PreferenceWrite[] = [];
			if (field === "supportAccess" && nextValue) {
				const previousExpiry = preferences.supportExpiry;
				const nextExpiry = Date.now() + supportDurationHours * ONE_HOUR_MS;
				previous.supportExpiry = previousExpiry;
				next.supportExpiry = nextExpiry;
				writes.push({
					key: PRIVACY_KEYS.supportExpiry,
					value: String(Math.max(0, Math.round(nextExpiry))),
				});
			}
			writes.push({ key, value: String(nextValue) });
			setPreferences((current) => ({ ...current, ...next }));
			void saveIntent({ label, writes, previous, next });
		},
		[preferences, saveIntent, supportDurationHours]
	);

	const editEndpoint = useCallback(() => {
		// Start blank because the shared terminal TextInput places its cursor at
		// the start of a controlled value. Entering an endpoint replaces the
		// current value; submitting an empty string clears it.
		setEndpointDraft("");
		editingEndpointRef.current = true;
		onEditingChange(true);
		setEditingEndpoint(true);
		setError(null);
		setNotice(null);
	}, [onEditingChange]);

	const commitEndpoint = useCallback(
		(value: string) => {
			const endpoint = value.trim();
			const previous = preferences.diagnosticsEndpoint;
			setEndpointDraft(endpoint);
			void saveIntent({
				label: "the diagnostics endpoint",
				writes: [{ key: PRIVACY_KEYS.diagnosticsEndpoint, value: endpoint }],
				previous: { diagnosticsEndpoint: previous },
				next: { diagnosticsEndpoint: endpoint },
				closeEndpointEditor: true,
			});
		},
		[preferences.diagnosticsEndpoint, saveIntent]
	);

	const toggleContentMode = useCallback(() => {
		const previous = preferences.diagnosticsContentMode;
		const next: DiagnosticsContentMode =
			previous === "content" ? "metadata_only" : "content";
		setPreferences((current) => ({ ...current, diagnosticsContentMode: next }));
		void saveIntent({
			label: "the diagnostics content mode",
			writes: [{ key: PRIVACY_KEYS.diagnosticsContentMode, value: next }],
			previous: { diagnosticsContentMode: previous },
			next: { diagnosticsContentMode: next },
		});
	}, [preferences.diagnosticsContentMode, saveIntent]);

	// Core sends one `ryu.test` span and flushes it. It refuses (409) while
	// export consent is off, so this never sends anything not already allowed.
	const sendTestSpan = useCallback(async () => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const raw = await request(
				target,
				"/api/diagnostics/otlp/test-span",
				{ method: "POST" },
				appResponseValueSchema
			);
			const parsed = testSpanResponseSchema.safeParse(raw);
			setNotice(
				parsed.success
					? tf(
							"Test span sent to {endpoint}. Look for ryu.test in your collector.",
							{ endpoint: parsed.data.endpoint }
						)
					: "Test span sent."
			);
		} catch (testError) {
			setError(
				tf("Couldn't send the test span: {error}", {
					error: errorMessage(testError),
				})
			);
		} finally {
			setBusy(false);
		}
	}, [busy, target]);

	const cycleSupportDuration = useCallback(
		(direction: -1 | 1) => {
			if (preferences.supportAccess) {
				setNotice("End the current grant before changing its duration.");
				return;
			}
			const currentIndex =
				SUPPORT_DURATION_INDEX.get(supportDurationHours) ?? -1;
			const nextIndex =
				(currentIndex + direction + SUPPORT_DURATION_HOURS.length) %
				SUPPORT_DURATION_HOURS.length;
			setSupportDurationHours(SUPPORT_DURATION_HOURS[nextIndex] ?? 1);
			setNotice(null);
		},
		[preferences.supportAccess, supportDurationHours]
	);

	const activateSelected = useCallback(() => {
		if (loadState !== "ready" || busy) {
			return;
		}
		if (selected === "analytics") {
			toggleBoolean(
				"analytics",
				PRIVACY_KEYS.analytics,
				"the analytics choice"
			);
		} else if (selected === "community") {
			toggleBoolean(
				"community",
				PRIVACY_KEYS.community,
				"the community-stats choice"
			);
		} else if (selected === "profileActivity") {
			toggleBoolean(
				"profileActivity",
				PRIVACY_KEYS.profileActivity,
				"the profile-activity choice"
			);
		} else if (selected === "crashReports") {
			toggleBoolean(
				"crashReports",
				PRIVACY_KEYS.crashReports,
				"the crash-report choice"
			);
		} else if (selected === "diagnosticsExport") {
			toggleBoolean(
				"diagnosticsExport",
				PRIVACY_KEYS.diagnosticsExport,
				"the diagnostics-export choice"
			);
		} else if (selected === "diagnosticsEndpoint") {
			editEndpoint();
		} else if (selected === "diagnosticsContentMode") {
			toggleContentMode();
		} else if (selected === "supportAccess") {
			toggleBoolean(
				"supportAccess",
				PRIVACY_KEYS.supportAccess,
				preferences.supportAccess
					? "ending support access"
					: "granting support access"
			);
		} else {
			setNotice("Use ← / → to choose the support-access duration.");
		}
	}, [
		busy,
		editEndpoint,
		loadState,
		preferences.supportAccess,
		selected,
		toggleBoolean,
		toggleContentMode,
	]);

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
		}
	}, [busy, loadPreferences, loadState, retryIntent, saveIntent]);

	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		if (editingEndpointRef.current) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			if (key.name === "k") {
				return;
			}
			setSelectedIndex((index) => Math.max(0, index - 1));
			return;
		}
		if (key.name === "down" || key.name === "j") {
			if (key.name === "j") {
				return;
			}
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
		if (selected === "supportDuration" && key.name === "left") {
			cycleSupportDuration(-1);
			return;
		}
		if (selected === "supportDuration" && key.name === "right") {
			cycleSupportDuration(1);
			return;
		}
		if (selected === "diagnosticsEndpoint" && key.name === "e") {
			editEndpoint();
			return;
		}
		if (
			(selected === "diagnosticsEndpoint" ||
				selected === "diagnosticsContentMode") &&
			key.name === "t"
		) {
			void sendTestSpan();
			return;
		}
		if (key.name === "return" || key.name === " " || key.name === "space") {
			activateSelected();
		}
	});

	const supportIsActive =
		preferences.supportAccess &&
		(preferences.supportExpiry === 0 || Date.now() < preferences.supportExpiry);
	const supportState = supportIsActive
		? preferences.supportExpiry === 0
			? "ON · no expiry"
			: `ON until ${new Date(preferences.supportExpiry).toLocaleString()}`
		: preferences.supportAccess
			? "Expired"
			: "OFF";
	const themeColor = theme.colors;

	return (
		<Card
			subtitle="Consent and export preferences stored by Core"
			title="Privacy"
		>
			{loadState === "loading" ? (
				<text fg={themeColor.mutedForeground}>
					Loading Core privacy preferences…
				</text>
			) : null}
			<PrivacyRows
				commitEndpoint={commitEndpoint}
				editingEndpoint={editingEndpoint}
				endpointDraft={endpointDraft}
				preferences={preferences}
				selectedIndex={selectedIndex}
				setEndpointDraft={setEndpointDraft}
				supportDurationHours={supportDurationHours}
				supportState={supportState}
				themeColor={themeColor}
			/>
			<PrivacyFooter
				busy={busy}
				editingEndpoint={editingEndpoint}
				error={error}
				notice={notice}
				themeColor={themeColor}
			/>
		</Card>
	);
}
