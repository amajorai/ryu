import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { TextInput } from "@/components/ui/text-input.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";

const PRIVACY_KEYS = {
	analytics: "product-analytics-enabled",
	community: "community-stats-enabled",
	profileActivity: "profile-activity-enabled",
	crashReports: "crash-reports-enabled",
	diagnosticsExport: "diagnostics-export-enabled",
	diagnosticsEndpoint: "diagnostics-otlp-endpoint",
	diagnosticsContentMode: "diagnostics-otlp-content-mode",
	supportAccess: "support-access-local-enabled",
	supportExpiry: "support-access-local-expiry",
} as const;

const PRIVACY_KEY_ORDER = [
	PRIVACY_KEYS.analytics,
	PRIVACY_KEYS.community,
	PRIVACY_KEYS.profileActivity,
	PRIVACY_KEYS.crashReports,
	PRIVACY_KEYS.diagnosticsExport,
	PRIVACY_KEYS.diagnosticsEndpoint,
	PRIVACY_KEYS.diagnosticsContentMode,
	PRIVACY_KEYS.supportAccess,
	PRIVACY_KEYS.supportExpiry,
] as const;

const DEFAULTS: PrivacyPreferences = {
	analytics: true,
	community: true,
	profileActivity: true,
	crashReports: true,
	diagnosticsExport: false,
	diagnosticsEndpoint: "",
	diagnosticsContentMode: "metadata_only",
	supportAccess: false,
	supportExpiry: 0,
};

const SUPPORT_DURATION_HOURS = [1, 8, 24] as const;
const SUPPORT_DURATION_INDEX = new Map<number, number>(
	SUPPORT_DURATION_HOURS.map((duration, index) => [duration, index])
);
const ONE_HOUR_MS = 60 * 60 * 1000;
const ROWS = [
	"analytics",
	"community",
	"profileActivity",
	"crashReports",
	"diagnosticsExport",
	"diagnosticsEndpoint",
	"diagnosticsContentMode",
	"supportDuration",
	"supportAccess",
] as const;

type DiagnosticsContentMode = "metadata_only" | "content";

interface PrivacyPreferences {
	analytics: boolean;
	community: boolean;
	crashReports: boolean;
	diagnosticsContentMode: DiagnosticsContentMode;
	diagnosticsEndpoint: string;
	diagnosticsExport: boolean;
	profileActivity: boolean;
	supportAccess: boolean;
	supportExpiry: number;
}

const privacyPreferenceSchema = z.object({ value: z.json().optional() });
type PreferenceWire = z.infer<typeof privacyPreferenceSchema>;
type PrivacyPreferenceValue = PreferenceWire["value"];
const privacyStringSchema = z.string();
const privacyErrorSchema = z.instanceof(Error);
const testSpanResponseSchema = z.object({ endpoint: z.string() });
function requestPrivacyPreference(target: ApiTarget, path: string) {
	return request(target, path, {}, appResponseValueSchema).then((raw) =>
		privacyPreferenceSchema.parse(raw)
	);
}

interface PreferenceWrite {
	key: string;
	value: string;
}

interface SaveIntent {
	closeEndpointEditor?: boolean;
	label: string;
	next: Partial<PrivacyPreferences>;
	previous: Partial<PrivacyPreferences>;
	writes: readonly PreferenceWrite[];
}

function parseBoolean(raw: PrivacyPreferenceValue, fallback: boolean): boolean {
	const parsed = privacyStringSchema.safeParse(raw);
	if (!parsed.success) {
		return fallback;
	}
	switch (parsed.data.trim().toLowerCase()) {
		case "true":
		case "1":
		case "on":
		case "yes":
			return true;
		case "false":
		case "0":
		case "off":
		case "no":
			return false;
		default:
			return fallback;
	}
}

/** Mirrors Core's tolerant `ContentMode::parse`: only `content` (or `full`)
 * opts in; anything else keeps the metadata-only default. */
function parseContentMode(
	raw: string | null | undefined
): DiagnosticsContentMode {
	const value = raw?.trim().toLowerCase();
	return value === "content" || value === "full" ? "content" : "metadata_only";
}

function rawValue(wire: PreferenceWire): string | null {
	const parsed = privacyStringSchema.safeParse(wire.value);
	return parsed.success ? parsed.data : null;
}

function errorMessage(
	error: Parameters<typeof privacyErrorSchema.safeParse>[0]
): string {
	const parsed = privacyErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

function parseExpiry(raw: string | null): number {
	if (raw === null) {
		return 0;
	}
	const parsed = Number(raw.trim());
	return Number.isFinite(parsed) ? parsed : 0;
}

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
					`Couldn't load privacy preferences: ${errorMessage(loadError)}. Press r to retry.`
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
					`Couldn't save ${intent.label}: ${errorMessage(saveError)}. Press r to retry.`
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
					? `Test span sent to ${parsed.data.endpoint}. Look for ryu.test in your collector.`
					: "Test span sent."
			);
		} catch (testError) {
			setError(`Couldn't send the test span: ${errorMessage(testError)}`);
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
			{ROWS.map((row, index) => {
				const isSelected = selectedIndex === index;
				const color = isSelected ? themeColor.primary : themeColor.foreground;
				const prefix = isSelected ? "›" : " ";
				let label = "";
				let value = "";
				let description = "";
				if (row === "analytics") {
					label = "Anonymous usage analytics";
					value = preferences.analytics ? "ON" : "OFF";
					description = "Content-free product events; enabled by default.";
				} else if (row === "community") {
					label = "Community stats";
					value = preferences.community ? "ON" : "OFF";
					description = "Anonymous aggregate savings; enabled by default.";
				} else if (row === "profileActivity") {
					label = "Profile activity";
					value = preferences.profileActivity ? "ON" : "OFF";
					description =
						"Chats and agent runs count toward your streak; daily usage totals join your profile stats. No content.";
				} else if (row === "crashReports") {
					label = "Crash reports";
					value = preferences.crashReports ? "ON" : "OFF";
					description = "Separate consent tier; enabled by default.";
				} else if (row === "diagnosticsExport") {
					label = "Diagnostics export";
					value = preferences.diagnosticsExport ? "ON" : "OFF · opt-in";
					description =
						"Core and Gateway export local traces to your endpoint.";
				} else if (row === "diagnosticsEndpoint") {
					label = "OTLP endpoint";
					value = editingEndpoint
						? "editing"
						: preferences.diagnosticsEndpoint || "not set";
					description =
						"No destination means diagnostics remain local-only. Press t to send a test span.";
				} else if (row === "diagnosticsContentMode") {
					label = "Content mode";
					value =
						preferences.diagnosticsContentMode === "content"
							? "Full content"
							: "Metadata only";
					description =
						preferences.diagnosticsContentMode === "content"
							? "Prompts, responses, and tool data leave this device for your collector."
							: "Spans carry models, tokens, timings, and errors; never prompts.";
				} else if (row === "supportDuration") {
					label = "Support-access duration";
					value = `${supportDurationHours} ${supportDurationHours === 1 ? "hour" : "hours"}`;
					description = preferences.supportAccess
						? "End the active grant before changing duration."
						: "Grant expiry is written before access is enabled.";
				} else {
					label = "Local support access";
					value = supportState;
					description =
						"Read-only, audited Core diagnostics; requires private mesh transport.";
				}
				return (
					<box flexDirection="column" flexShrink={0} key={row} marginTop={1}>
						<box flexDirection="row" gap={1}>
							<text fg={color}>{prefix}</text>
							<text fg={color}>{isSelected ? <b>{label}</b> : label}</text>
							<text fg={themeColor.mutedForeground}>{value}</text>
						</box>
						{isSelected ? (
							<text fg={themeColor.mutedForeground}>{description}</text>
						) : null}
						{row === "diagnosticsEndpoint" && editingEndpoint ? (
							<TextInput
								bordered={false}
								label="Endpoint"
								onChange={setEndpointDraft}
								onSubmit={commitEndpoint}
								placeholder="New endpoint; blank clears"
								value={endpointDraft}
								width={48}
							/>
						) : null}
					</box>
				);
			})}
			{error ? (
				<box marginTop={1}>
					<text fg={themeColor.error}>{error}</text>
				</box>
			) : null}
			{notice ? (
				<box marginTop={1}>
					<text fg={themeColor.success}>{notice}</text>
				</box>
			) : null}
			{busy ? (
				<box marginTop={1}>
					<text fg={themeColor.mutedForeground}>
						Saving to Core and confirming…
					</text>
				</box>
			) : null}
			<box marginTop={1}>
				<text fg={themeColor.mutedForeground}>
					{editingEndpoint
						? "Type endpoint · Enter save · Esc close settings"
						: "↑↓ move rows · j/k change Settings panels · Enter toggle · e edit endpoint · t test span · ←/→ duration · r retry/load"}
				</text>
			</box>
			<box marginTop={1}>
				<text fg={themeColor.mutedForeground}>
					Disclosure details and the local event inspector are available in
					Desktop Settings → Privacy.
				</text>
			</box>
		</Card>
	);
}
