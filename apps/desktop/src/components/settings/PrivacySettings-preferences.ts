// apps/desktop/src/components/settings/PrivacySettings-preferences.ts
//
// Privacy preference state for the Privacy tab: load from Core and write back.

import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { setAnalyticsEnabled } from "@/src/lib/analytics.ts";
import { sendDiagnosticsTestSpan } from "@/src/lib/api/diagnostics.ts";
import {
	DEFAULT_DIAGNOSTICS_CONTENT_MODE,
	type DiagnosticsContentMode,
	type DiagnosticsExporterField,
	type DiagnosticsExporterSettings,
	getCommunityStatsEnabled,
	getCrashReportsEnabled,
	getDiagnosticsContentMode,
	getDiagnosticsExportEnabled,
	getDiagnosticsExporterSettings,
	getDiagnosticsOtlpEndpoint,
	getProductAnalyticsEnabled,
	getProfileActivityEnabled,
	getSupportAccessLocalEnabled,
	getSupportAccessLocalExpiry,
	isSecretReference,
	parseDiagnosticsContentMode,
	parseDiagnosticsExporterPreset,
	setCommunityStatsEnabled,
	setCrashReportsEnabled,
	setDiagnosticsContentMode,
	setDiagnosticsExportEnabled,
	setDiagnosticsExporterField,
	setDiagnosticsExporterPreset,
	setDiagnosticsOtlpEndpoint,
	setProductAnalyticsEnabled,
	setProfileActivityEnabled,
	setSupportAccessLocalEnabled,
	setSupportAccessLocalExpiry,
} from "@/src/lib/api/preferences.ts";
import { setCrashReportingEnabled } from "@/src/lib/crash.ts";
import {
	DEFAULT_SUPPORT_DURATION_HOURS,
	EMPTY_EXPORTER,
	ONE_HOUR_MS,
	SECRET_REFERENCE_FIELDS,
} from "./PrivacySettings-options.ts";
import type { PrivacyRuntime } from "./PrivacySettings-runtime.ts";
import { waitPrivacyWrites } from "./PrivacySettings-writes.ts";

export function usePrivacyPreferences({
	epoch,
	isCurrent,
	loadAttempt,
	mounted,
	pendingWrites,
	physicalResource,
	privacyReady,
	runMutation,
	setLoadedEpoch,
	setPrivacyLoadError,
	target,
}: PrivacyRuntime) {
	const tl = useLiteralMessages();
	const [productAnalytics, setProductAnalytics] = useState(true);
	const [communityStats, setCommunityStats] = useState(true);
	const [profileActivity, setProfileActivity] = useState(true);
	const [crashReports, setCrashReports] = useState(true);
	const [diagnosticsExport, setDiagnosticsExport] = useState(false);
	const [otlpEndpoint, setOtlpEndpoint] = useState("");
	const [exporter, setExporter] =
		useState<DiagnosticsExporterSettings>(EMPTY_EXPORTER);
	const [contentMode, setContentMode] = useState<DiagnosticsContentMode>(
		DEFAULT_DIAGNOSTICS_CONTENT_MODE
	);
	const [testSpanBusy, setTestSpanBusy] = useState(false);
	const [supportAccess, setSupportAccess] = useState(false);
	const [supportExpiry, setSupportExpiry] = useState(0);
	const [supportDurationHours, setSupportDurationHours] = useState(
		DEFAULT_SUPPORT_DURATION_HOURS
	);

	useEffect(() => {
		let cancelled = false;
		setLoadedEpoch(null);
		setPrivacyLoadError(null);
		setAnalyticsEnabled(false);
		setCrashReportingEnabled(false);
		waitPrivacyWrites(physicalResource)
			.then(() => {
				if (cancelled || !isCurrent()) {
					return null;
				}
				return Promise.all([
					getProductAnalyticsEnabled(target),
					getCommunityStatsEnabled(target),
					getProfileActivityEnabled(target),
					getCrashReportsEnabled(target),
					getDiagnosticsExportEnabled(target),
					getDiagnosticsOtlpEndpoint(target),
					getDiagnosticsContentMode(target),
					getDiagnosticsExporterSettings(target),
					getSupportAccessLocalEnabled(target),
					getSupportAccessLocalExpiry(target),
				]);
			})
			.then((values) => {
				if (cancelled || !isCurrent() || values === null) {
					return;
				}
				const [
					analytics,
					community,
					activity,
					crashes,
					exportOn,
					endpoint,
					mode,
					exporterSettings,
					support,
					expiry,
				] = values;
				setProductAnalytics(analytics);
				setCommunityStats(community);
				setProfileActivity(activity);
				// Seed the analytics runtime gate from the canonical Core pref, so the
				// in-memory flag + the localStorage mirror agree with what the user chose.
				setAnalyticsEnabled(analytics);
				setCrashReports(crashes);
				// Seed the crash-reporting runtime gate from the canonical Core pref
				// (separate consent tier) so the in-memory flag + localStorage mirror
				// agree with what the user chose.
				setCrashReportingEnabled(crashes);
				setDiagnosticsExport(exportOn);
				setOtlpEndpoint(endpoint);
				setContentMode(mode);
				setExporter(exporterSettings);
				setSupportAccess(support);
				setSupportExpiry(expiry);
				setLoadedEpoch(epoch);
			})
			.catch(() => {
				if (cancelled || !isCurrent()) {
					return;
				}
				setPrivacyLoadError(
					"Couldn't load privacy choices. Retry before changing them."
				);
			});
		return () => {
			cancelled = true;
		};
	}, [target, physicalResource, epoch, isCurrent, loadAttempt]);

	const handleProductAnalytics = useCallback(
		(next: boolean) => {
			void runMutation(
				"analytics",
				() => setProductAnalyticsEnabled(target, next),
				() => {
					setProductAnalytics(next);
					if (!next) {
						setAnalyticsEnabled(false);
					}
				},
				() => {
					setProductAnalytics(productAnalytics);
					setAnalyticsEnabled(productAnalytics);
				},
				"Couldn't save your analytics choice",
				privacyReady,
				() => {
					if (next) {
						setAnalyticsEnabled(true);
					}
				}
			);
		},
		[runMutation, target, productAnalytics, privacyReady]
	);
	const handleCommunityStats = useCallback(
		(next: boolean) => {
			void runMutation(
				"community",
				() => setCommunityStatsEnabled(target, next),
				() => setCommunityStats(next),
				() => setCommunityStats(communityStats),
				"Couldn't save your community-stats choice"
			);
		},
		[runMutation, target, communityStats]
	);
	const handleProfileActivity = useCallback(
		(next: boolean) => {
			void runMutation(
				"profile-activity",
				() => setProfileActivityEnabled(target, next),
				() => setProfileActivity(next),
				() => setProfileActivity(profileActivity),
				"Couldn't save your profile-activity choice"
			);
		},
		[runMutation, target, profileActivity]
	);
	const handleCrashReports = useCallback(
		(next: boolean) => {
			void runMutation(
				"crashes",
				() => setCrashReportsEnabled(target, next),
				() => {
					setCrashReports(next);
					if (!next) {
						setCrashReportingEnabled(false);
					}
				},
				() => {
					setCrashReports(crashReports);
					setCrashReportingEnabled(crashReports);
				},
				"Couldn't save your crash-report choice",
				privacyReady,
				() => {
					if (next) {
						setCrashReportingEnabled(true);
					}
				}
			);
		},
		[runMutation, target, crashReports, privacyReady]
	);
	const handleDiagnosticsExport = useCallback(
		(next: boolean) => {
			void runMutation(
				"diagnostics",
				() => setDiagnosticsExportEnabled(target, next),
				() => setDiagnosticsExport(next),
				() => setDiagnosticsExport(diagnosticsExport),
				"Couldn't save your diagnostics-export choice"
			);
		},
		[runMutation, target, diagnosticsExport]
	);
	const handleOtlpEndpoint = useCallback(
		(e: ChangeEvent<HTMLInputElement>) => {
			if (isCurrent()) {
				setOtlpEndpoint(e.target.value);
			}
		},
		[isCurrent]
	);
	const commitOtlpEndpoint = useCallback(() => {
		void runMutation(
			"endpoint",
			() => setDiagnosticsOtlpEndpoint(target, otlpEndpoint),
			() => undefined,
			() => undefined,
			"Couldn't save the diagnostics endpoint"
		);
	}, [runMutation, target, otlpEndpoint]);
	const handleExporterPreset = useCallback(
		(value: string | null) => {
			const next = parseDiagnosticsExporterPreset(value);
			const previous = exporter.preset;
			void runMutation(
				"exporter-preset",
				() => setDiagnosticsExporterPreset(target, next),
				() => setExporter((current) => ({ ...current, preset: next })),
				() => setExporter((current) => ({ ...current, preset: previous })),
				"Couldn't save the diagnostics destination"
			);
		},
		[runMutation, target, exporter.preset]
	);
	const handleExporterField = useCallback(
		(field: DiagnosticsExporterField, value: string) => {
			if (isCurrent()) {
				setExporter((current) => ({ ...current, [field]: value }));
			}
		},
		[isCurrent]
	);
	const commitExporterField = useCallback(
		(field: DiagnosticsExporterField) => {
			const value = exporter[field];
			// Core refuses a literal credential; say why here instead of a
			// generic save failure, and never send the pasted value.
			if (SECRET_REFERENCE_FIELDS.has(field) && !isSecretReference(value)) {
				toast.error("Use a secret reference, not the key itself", {
					description:
						"Enter env:NAME, file:/absolute/path, or secret:NAME (a node vault secret).",
				});
				return;
			}
			void runMutation(
				`exporter-${field}`,
				() => setDiagnosticsExporterField(target, field, value),
				() => undefined,
				() => undefined,
				"Couldn't save the diagnostics destination"
			);
		},
		[runMutation, target, exporter]
	);
	const handleContentMode = useCallback(
		(value: string | null) => {
			const next = parseDiagnosticsContentMode(value);
			void runMutation(
				"content-mode",
				() => setDiagnosticsContentMode(target, next),
				() => setContentMode(next),
				() => setContentMode(contentMode),
				"Couldn't save the diagnostics content mode"
			);
		},
		[runMutation, target, contentMode]
	);
	// Not a preference write: Core sends one `ryu.test` span and flushes it. Core
	// refuses while export consent is off, so this never sends anything the user
	// has not already allowed.
	const handleSendTestSpan = useCallback(async () => {
		if (!(isCurrent() && privacyReady) || testSpanBusy) {
			return;
		}
		setTestSpanBusy(true);
		try {
			const result = await sendDiagnosticsTestSpan(target);
			if (!isCurrent()) {
				return;
			}
			if (result.ok) {
				toast.success("Test span sent", {
					description: tl("Look for a ryu.test span at {endpoint}.", {
						endpoint: result.endpoint,
					}),
				});
			} else {
				toast.error("Couldn't send the test span", {
					description: result.message,
				});
			}
		} catch {
			if (isCurrent()) {
				toast.error("Couldn't send the test span", {
					description: "Check your connection and try again.",
				});
			}
		} finally {
			// Clear the busy flag even if the node or credentials changed
			// meanwhile; the component stays mounted for the new identity.
			if (mounted.current) {
				setTestSpanBusy(false);
			}
		}
	}, [isCurrent, privacyReady, target, testSpanBusy, tl]);
	const handleSupportAccess = useCallback(
		(next: boolean) => {
			let acknowledgedExpiry = supportExpiry;
			void runMutation(
				"support",
				async () => {
					if (next) {
						const expiry = Date.now() + supportDurationHours * ONE_HOUR_MS;
						// A finite expiry must be durable before access is enabled.
						await setSupportAccessLocalExpiry(target, expiry);
						acknowledgedExpiry = expiry;
						if (!isCurrent()) {
							return;
						}
						setSupportExpiry(expiry);
						await setSupportAccessLocalEnabled(target, true);
					} else {
						await setSupportAccessLocalEnabled(target, false);
					}
				},
				() => setSupportAccess(next),
				() => {
					setSupportAccess(supportAccess);
					// The expiry ACK remains durable if only the second write refused.
					setSupportExpiry(acknowledgedExpiry);
				},
				next ? "Couldn't grant support access" : "Couldn't end support access"
			);
		},
		[
			runMutation,
			target,
			supportAccess,
			supportExpiry,
			supportDurationHours,
			isCurrent,
		]
	);

	const handleSupportDuration = useCallback(
		(value: string | null) => {
			if (
				!(isCurrent() && privacyReady) ||
				pendingWrites.current.has("support")
			) {
				return;
			}
			const hours = Number(value);
			setSupportDurationHours(
				Number.isFinite(hours) && hours > 0
					? hours
					: DEFAULT_SUPPORT_DURATION_HOURS
			);
		},
		[isCurrent, privacyReady]
	);

	return {
		commitExporterField,
		commitOtlpEndpoint,
		communityStats,
		contentMode,
		crashReports,
		diagnosticsExport,
		exporter,
		handleCommunityStats,
		handleContentMode,
		handleCrashReports,
		handleDiagnosticsExport,
		handleExporterField,
		handleExporterPreset,
		handleOtlpEndpoint,
		handleProductAnalytics,
		handleProfileActivity,
		handleSendTestSpan,
		handleSupportAccess,
		handleSupportDuration,
		otlpEndpoint,
		productAnalytics,
		profileActivity,
		supportAccess,
		supportDurationHours,
		supportExpiry,
		testSpanBusy,
	};
}

export type PrivacyPreferences = ReturnType<typeof usePrivacyPreferences>;
