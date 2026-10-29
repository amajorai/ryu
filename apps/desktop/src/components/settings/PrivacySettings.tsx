// apps/desktop/src/components/settings/PrivacySettings.tsx
//
// The Privacy tab (P0 of docs/observability-analytics-support-access.md). It
// surfaces the independent consent toggles from the §6 defaults table, each
// defaulting per that table — closed-UI product analytics + crash reports are
// opt-out (ON by default), while data-plane OTLP diagnostics export and local
// Core support access are opt-in (OFF). The first-run disclosure is completed
// in onboarding; this tab remains the place to review or change it later.
//
// The canonical Core preferences are the source of truth. This tab also seeds
// the live analytics and crash gates immediately, while Core/Gateway read the
// same preferences when their exporters start; collection cannot precede the
// user's persisted choice.

import {
	Alert01Icon,
	ChartLineData01Icon,
	CloudServerIcon,
	SecurityCheckIcon,
	Stethoscope02Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import { setAnalyticsEnabled } from "@/src/lib/analytics.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { apiUrl } from "@/src/lib/api/client.ts";
import { sendDiagnosticsTestSpan } from "@/src/lib/api/diagnostics.ts";
import { getHealingConfig, setHealingConfig } from "@/src/lib/api/healing.ts";
import {
	DEFAULT_DIAGNOSTICS_CONTENT_MODE,
	type DiagnosticsContentMode,
	type DiagnosticsExporterField,
	type DiagnosticsExporterPreset,
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
import { formatDateTime } from "@/src/lib/timezone.ts";
import { AnalyticsInspector } from "./AnalyticsInspector.tsx";
import { CustomAppSecuritySettings } from "./CustomAppSecuritySettings.tsx";
import { DevicePermissionsSettings } from "./DevicePermissionsSettings.tsx";
import { NotificationSettings } from "./NotificationSettings.tsx";
import {
	acknowledgePrivacyDisclosure,
	PRIVACY_DOCS_PATH as DOCS_PATH,
	isPrivacyDisclosureAcknowledged,
} from "./privacy-disclosure-state.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TrainingDataNotice } from "./TrainingDataNotice.tsx";

// Hard-expiry duration options for a support-access grant. The §6 / §5.1 design
// keeps the support tier short (the impersonation tier uses <=1 hr); the user
// picks how long this scoped local channel stays open. A grant ALWAYS writes a
// non-zero expiry so Core's startup sweep can auto-disable it (a zero expiry
// would mean "never expires", which is not what a support grant should be).
const ONE_HOUR_MS = 60 * 60 * 1000;
const SUPPORT_DURATION_OPTIONS = [1, 8, 24] as const;
const DEFAULT_SUPPORT_DURATION_HOURS = 1;

// OTLP content modes. Metadata only is the default posture; full content is a
// separate opt-in that Core still gates on diagnostics export consent.
const CONTENT_MODE_OPTIONS: ReadonlyArray<{
	label: string;
	value: DiagnosticsContentMode;
}> = [
	{ label: "Metadata only", value: "metadata_only" },
	{ label: "Full content", value: "content" },
];

// Exporter presets: hosted LLM-observability backends Core maps onto OTLP.
// `fields` lists the preset-specific inputs shown under the destination picker.
const EXPORTER_PRESET_OPTIONS: ReadonlyArray<{
	fields: readonly DiagnosticsExporterField[];
	label: string;
	value: DiagnosticsExporterPreset;
}> = [
	{ fields: ["apiKeyRef"], label: "Any OTLP endpoint", value: "otlp" },
	{
		fields: ["publicKeyRef", "apiKeyRef", "region"],
		label: "Langfuse",
		value: "langfuse",
	},
	{
		fields: ["apiKeyRef", "project", "region"],
		label: "LangSmith",
		value: "langsmith",
	},
	{
		fields: ["apiKeyRef", "project"],
		label: "Braintrust",
		value: "braintrust",
	},
	{
		fields: ["apiKeyRef", "project"],
		label: "Arize Phoenix",
		value: "phoenix",
	},
	{ fields: ["apiKeyRef", "region"], label: "Helicone", value: "helicone" },
	{
		fields: ["apiKeyRef", "project", "region"],
		label: "Datadog",
		value: "datadog",
	},
];

const EXPORTER_FIELD_COPY: Record<
	DiagnosticsExporterField,
	{ label: string; placeholder: string }
> = {
	apiKeyRef: {
		label: "API key reference",
		placeholder: "env:LANGSMITH_API_KEY",
	},
	project: { label: "Project", placeholder: "my-agents" },
	publicKeyRef: {
		label: "Public key reference",
		placeholder: "env:LANGFUSE_PUBLIC_KEY",
	},
	region: { label: "Region or site", placeholder: "us, eu, or us5" },
};

const SECRET_REFERENCE_FIELDS: ReadonlySet<DiagnosticsExporterField> = new Set([
	"apiKeyRef",
	"publicKeyRef",
]);

const EMPTY_EXPORTER: DiagnosticsExporterSettings = {
	apiKeyRef: "",
	preset: "otlp",
	project: "",
	publicKeyRef: "",
	region: "",
};

// Preferences belong to the physical node. An already-issued write can still
// settle after credentials change; a new authority must read after that ACK.
type PrivacyMutation = () => Promise<unknown>;
const privacyWrites = new Map<string, Set<Promise<void>>>();
function trackPrivacyWrite(url: string, write: PrivacyMutation): Promise<void> {
	const pending = privacyWrites.get(url) ?? new Set<Promise<void>>();
	privacyWrites.set(url, pending);
	const operation = Promise.resolve().then(async () => {
		await write();
	});
	pending.add(operation);
	const complete = () => {
		pending.delete(operation);
		if (pending.size === 0 && privacyWrites.get(url) === pending) {
			privacyWrites.delete(url);
		}
	};
	void operation.then(complete, complete);
	return operation;
}
async function waitPrivacyWrites(url: string) {
	while (privacyWrites.get(url)?.size) {
		await Promise.allSettled(privacyWrites.get(url)!);
	}
}

export function PrivacySettings() {
	// Which sub-page a pending settings-search hit is on — a row on a closed page
	// is not in the DOM the reveal polls.
	const pendingSubpage = usePendingSubpage("privacy");
	const activeNode = useActiveNode();
	// Memoize the target so it is stable across renders. A fresh object each
	// render would make the load effect (and every write callback) refire every
	// render, refetching all prefs and clobbering in-progress user input (e.g.
	// the OTLP endpoint field).
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);

	// The same physical API can be selected with a trailing slash. Share pending
	// writes using the shipping URL joiner, while UI epochs retain the full tuple.
	// Missing URLs are reported by the async API reads, not by rendering.
	const physicalResource = target.url.replace(/\/$/, "")
		? apiUrl(target, "")
		: "";
	const identity = JSON.stringify([target.url, target.token, target.userJwt]);
	const scope = useRef({ identity, epoch: 0 });
	const pendingWrites = useRef(new Set<string>());
	if (scope.current.identity !== identity) {
		scope.current = { identity, epoch: scope.current.epoch + 1 };
		pendingWrites.current = new Set();
	}
	const epoch = scope.current.epoch;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const isCurrent = useCallback(
		() => mounted.current && scope.current.epoch === epoch,
		[epoch]
	);
	const [loadedEpoch, setLoadedEpoch] = useState<number | null>(null);
	const [healingEpoch, setHealingEpoch] = useState<number | null>(null);
	const [busyKeys, setBusyKeys] = useState<string[]>([]);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [privacyLoadError, setPrivacyLoadError] = useState<string | null>(null);
	const [healingLoadError, setHealingLoadError] = useState<string | null>(null);
	const privacyReady = loadedEpoch === epoch;
	const healingReady = healingEpoch === epoch;
	const runMutation = useCallback(
		async (
			key: string,
			write: PrivacyMutation,
			optimistic: () => void,
			revert: () => void,
			title: string,
			ready = privacyReady,
			acknowledged?: () => void
		) => {
			if (!(isCurrent() && ready) || pendingWrites.current.has(key)) {
				return;
			}
			pendingWrites.current.add(key);
			setBusyKeys([...pendingWrites.current]);
			optimistic();
			try {
				let writeAcknowledged = false;
				await trackPrivacyWrite(physicalResource, async () => {
					if (!isCurrent()) {
						return;
					}
					await write();
					writeAcknowledged = true;
				});
				if (writeAcknowledged && isCurrent()) {
					acknowledged?.();
				}
			} catch {
				if (!isCurrent()) {
					return;
				}
				revert();
				toast.error(title, {
					description: "Check your connection and try again.",
				});
			} finally {
				if (isCurrent()) {
					pendingWrites.current.delete(key);
					setBusyKeys([...pendingWrites.current]);
				}
			}
		},
		[isCurrent, privacyReady, physicalResource]
	);

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
	// Self-healing: master switch defaults ON, auto-decide defaults OFF (propose to
	// the inbox, the user disposes). Seeded to match Core's defaults.
	const [healEnabled, setHealEnabledState] = useState(true);
	const [healAutoDecide, setHealAutoDecideState] = useState(false);
	const [supportDurationHours, setSupportDurationHours] = useState(
		DEFAULT_SUPPORT_DURATION_HOURS
	);

	const [disclosureAck, setDisclosureAck] = useState<boolean>(
		isPrivacyDisclosureAcknowledged
	);
	const acknowledgeDisclosure = useCallback(() => {
		setDisclosureAck(true);
		acknowledgePrivacyDisclosure();
	}, []);

	// Load the self-healing config independently (its own endpoint, not a pref).
	useEffect(() => {
		let cancelled = false;
		setBusyKeys([...pendingWrites.current]);
		setHealingEpoch(null);
		setHealingLoadError(null);
		waitPrivacyWrites(physicalResource)
			.then(() => {
				if (cancelled || !isCurrent()) {
					return null;
				}
				return getHealingConfig(target);
			})
			.then((cfg) => {
				if (cancelled || !isCurrent() || cfg === null) {
					return;
				}
				setHealEnabledState(cfg.enabled);
				setHealAutoDecideState(cfg.auto_decide);
				setHealingEpoch(epoch);
			})
			.catch(() => {
				if (cancelled || !isCurrent()) {
					return;
				}
				setHealingLoadError(
					"Couldn't load self-healing choices. Retry before changing them."
				);
			});
		return () => {
			cancelled = true;
		};
	}, [target, physicalResource, epoch, isCurrent, loadAttempt]);

	const handleHealEnabled = useCallback(
		(next: boolean) => {
			void runMutation(
				"healing",
				() => setHealingConfig(target, { enabled: next }),
				() => setHealEnabledState(next),
				() => setHealEnabledState(healEnabled),
				"Couldn't save your self-healing choice",
				healingReady
			);
		},
		[runMutation, target, healEnabled, healingReady]
	);
	const handleHealAutoDecide = useCallback(
		(next: boolean) => {
			void runMutation(
				"healing",
				() => setHealingConfig(target, { auto_decide: next }),
				() => setHealAutoDecideState(next),
				() => setHealAutoDecideState(healAutoDecide),
				"Couldn't save your auto-fix choice",
				healingReady
			);
		},
		[runMutation, target, healAutoDecide, healingReady]
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

	// Open the published privacy/data page in the browser so the reference is a
	// real, followable link rather than a dead file path.
	const openDocs = useCallback(() => {
		Promise.resolve(openExternal(`${FRONTEND_URL}${DOCS_PATH}`)).catch(
			() => undefined
		);
	}, []);

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
					description: `Look for a ryu.test span at ${result.endpoint}.`,
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
	}, [isCurrent, privacyReady, target, testSpanBusy]);
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

	// ── Sub-pages ────────────────────────────────────────────────────────────
	// Seven sections, each a switch under a paragraph of explanation, in one
	// scroll — so the answer to "what does Ryu send anywhere" was four screens
	// long. Grouped into three pages the way iOS Privacy & Security is: what we
	// collect, what you can export or grant, and what runs on its own.
	//
	// The disclosure banner and "Learn more" stay on the index: the first is the
	// consent prompt itself, and the second is the plain-English summary that
	// makes the rest legible.
	//
	// Groups → page ids are mirrored in `SUBPAGE_BY_GROUP` (`settings-index.ts`)
	// so settings search can still reveal a row behind a closed page.
	const disclosureIntro = (
		<div className="space-y-6">
			<TrainingDataNotice />
			{disclosureAck ? null : (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button onClick={acknowledgeDisclosure} size="sm">
								Got it
							</Button>
						}
						title="How Ryu handles your data"
					>
						<p className="pb-1 text-muted-foreground text-xs leading-relaxed">
							Anonymous, content-free product analytics and crash reports are on
							by default so we can fix what breaks and improve the app. They
							never include your prompts, conversations, files, or any agent
							content, and they use a random install ID that is not linked to
							your account. Product analytics is separate from your local
							Core/Gateway traces and diagnostics: those stay on your device
							unless you turn on export to a destination you choose. You can
							change any of these any time. See{" "}
							<button
								className="text-primary underline underline-offset-2"
								onClick={openDocs}
								type="button"
							>
								our privacy &amp; data page
							</button>{" "}
							for the full breakdown.
						</p>
					</SettingsItem>
				</SettingsGroup>
			)}
		</div>
	);

	const sharingPage = (
		<>
			<SettingsSection
				caption="On by default. Ryu's anonymous, content-free usage events (which screens you open, whether onboarding finished, install success) help us improve Ryu. Managed nodes also send a small content-free heartbeat while this is on. Never includes prompts, conversations, files, or any agent content; identified only by a random install ID, not your account."
				title="Product analytics"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={productAnalytics}
								disabled={!privacyReady || busyKeys.includes("analytics")}
								id="product-analytics"
								onCheckedChange={handleProductAnalytics}
							/>
						}
						title="Share anonymous usage analytics"
					/>
					<SettingsItem
						actions={<AnalyticsInspector />}
						description="See the full list of events the app can send and a local log of what was sent from this install."
						title="What we send"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, opt-out. Shares anonymous, aggregate token-savings stats (request counts and tokens saved by the Gateway) so the community leaderboard reflects real usage. Never includes prompts, conversations, files, or any agent content; identified only by a random install ID, never your account or hostname. Turn it off anytime."
				title="Community stats"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={communityStats}
								disabled={!privacyReady || busyKeys.includes("community")}
								id="community-stats"
								onCheckedChange={handleCommunityStats}
							/>
						}
						title="Share anonymous community stats"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, opt-out. Linked to your account, not anonymous. When you're signed in, Ryu tells Ryu Cloud which days this account was active on this device, so they keep your profile streak going. If this device's Gateway doesn't already report usage to Ryu Cloud, it also sends this device's daily usage totals (tokens, requests, sessions, and requests per model) so your profile stats include them. These totals never earn points. Never prompts, conversations, files, or agent content."
				title="Profile activity"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={profileActivity}
								disabled={
									!privacyReady || busyKeys.includes("profile-activity")
								}
								id="profile-activity"
								onCheckedChange={handleProfileActivity}
							/>
						}
						description="Chats and agent runs on this device, including scheduled ones, count toward your streak, and this device's daily usage totals are included in your profile stats. No content is sent."
						title="Sync activity on this device to your profile"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, separate from analytics. Sends scrubbed crash and error stacks so we can fix what fails. No prompts or content."
				title="Crash reports"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={crashReports}
								disabled={!privacyReady || busyKeys.includes("crashes")}
								id="crash-reports"
								onCheckedChange={handleCrashReports}
							/>
						}
						title="Send crash and error reports"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const diagnosticsPage = (
		<>
			<SettingsSection
				caption="Off by default. With an endpoint, redacted traces go there. Ryu Cloud-enrolled nodes also send a small Core/Gateway summary to Ryu Axiom. Restart Core after endpoint changes."
				title="Diagnostics export"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={diagnosticsExport}
								disabled={!privacyReady || busyKeys.includes("diagnostics")}
								id="diagnostics-export"
								onCheckedChange={handleDiagnosticsExport}
							/>
						}
						title="Export local diagnostics over OTLP"
					/>
					<SettingsItem
						description="OTLP endpoint, e.g. https://api.axiom.co or a local Collector. Leave blank to keep diagnostics local-only. Restart Core after changing it."
						title={
							<span className="flex items-center gap-2">
								<HugeiconsIcon
									className="size-4 opacity-70"
									icon={CloudServerIcon}
								/>
								OTLP endpoint
							</span>
						}
					>
						<Input
							aria-label="OTLP endpoint"
							disabled={!privacyReady || busyKeys.includes("endpoint")}
							onBlur={commitOtlpEndpoint}
							onChange={handleOtlpEndpoint}
							placeholder="https://api.axiom.co"
							value={otlpEndpoint}
						/>
					</SettingsItem>
					<SettingsItem
						actions={
							<Select
								disabled={!privacyReady || busyKeys.includes("exporter-preset")}
								items={EXPORTER_PRESET_OPTIONS.map((option) => ({
									label: option.label,
									value: option.value,
								}))}
								onValueChange={handleExporterPreset}
								value={exporter.preset}
							>
								<SelectTrigger
									aria-label="Diagnostics destination"
									className="h-9 w-48"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{EXPORTER_PRESET_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Send spans to a hosted LLM-observability backend instead of a plain OTLP endpoint. Credentials are references (env:NAME, file:/absolute/path, or secret:NAME), never the key itself. Leave the endpoint blank to use the service's default host. Restart Core after changing these."
						title="Destination"
					>
						<div className="space-y-2 pb-1">
							{(
								EXPORTER_PRESET_OPTIONS.find(
									(option) => option.value === exporter.preset
								)?.fields ?? []
							).map((field) => (
								<Input
									aria-label={EXPORTER_FIELD_COPY[field].label}
									disabled={
										!privacyReady || busyKeys.includes(`exporter-${field}`)
									}
									key={field}
									onBlur={() => commitExporterField(field)}
									onChange={(event) =>
										handleExporterField(field, event.target.value)
									}
									placeholder={`${EXPORTER_FIELD_COPY[field].label}: ${EXPORTER_FIELD_COPY[field].placeholder}`}
									value={exporter[field]}
								/>
							))}
						</div>
					</SettingsItem>
					<SettingsItem
						actions={
							<Select
								disabled={!privacyReady || busyKeys.includes("content-mode")}
								items={CONTENT_MODE_OPTIONS.map((option) => ({
									label: option.label,
									value: option.value,
								}))}
								onValueChange={handleContentMode}
								value={contentMode}
							>
								<SelectTrigger aria-label="Content mode" className="h-9 w-40">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CONTENT_MODE_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Metadata only (the default) sends model names, token counts, timings, and errors. Full content also sends prompts, responses, system instructions, and tool arguments and results. Nothing is sent while export is off."
						title="Content mode"
					>
						{contentMode === "content" ? (
							<p className="flex items-start gap-1.5 pb-1 text-status-warning text-xs leading-relaxed">
								<HugeiconsIcon
									className="mt-0.5 size-3.5 shrink-0"
									icon={Alert01Icon}
								/>
								Your prompts, model responses, and tool data will leave this
								device and be stored by the collector you configured. Large
								spans are truncated to a size cap. Only choose this for a
								destination you control.
							</p>
						) : null}
					</SettingsItem>
					<SettingsItem
						actions={
							<Button
								disabled={
									!(
										privacyReady &&
										diagnosticsExport &&
										(otlpEndpoint.trim() || exporter.preset !== "otlp")
									) || testSpanBusy
								}
								onClick={handleSendTestSpan}
								size="sm"
								variant="secondary"
							>
								{testSpanBusy ? "Sending…" : "Send test span"}
							</Button>
						}
						description="Sends one ryu.test span to your endpoint so you can confirm the address and auth headers. Requires export to be on, and a Core restart after the endpoint changes."
						title="Test destination"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Off by default. When you grant it, Ryu opens a limited, read-only diagnostic channel (logs, background-service status, and configuration with secrets removed) so our support team can help. It never exposes your prompts, conversations, or passwords, every access is recorded on your device, and it turns itself off automatically. Turn it off any time."
				title="Support access (local)"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={supportAccess}
								disabled={!privacyReady || busyKeys.includes("support")}
								id="support-access-local"
								onCheckedChange={handleSupportAccess}
							/>
						}
						description={
							supportAccess && supportExpiry > 0
								? `Active until ${formatDateTime(supportExpiry)}. Diagnostics are sent only over your private, encrypted connection.`
								: "Requires your private, encrypted connection to be turned on so diagnostics stay on your own network."
						}
						title="Grant local support access"
					/>
					<SettingsItem
						actions={
							<Select
								disabled={
									!privacyReady || supportAccess || busyKeys.includes("support")
								}
								items={SUPPORT_DURATION_OPTIONS.map((hours) => ({
									label: hours === 1 ? "1 hour" : `${hours} hours`,
									value: String(hours),
								}))}
								onValueChange={handleSupportDuration}
								value={String(supportDurationHours)}
							>
								<SelectTrigger className="h-9 w-40">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SUPPORT_DURATION_OPTIONS.map((hours) => (
										<SelectItem key={hours} value={String(hours)}>
											{hours === 1 ? "1 hour" : `${hours} hours`}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Access turns itself off after this, and is re-checked each time Ryu restarts. You can also end it any time from the banner."
						title="Access duration"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const healingPage = (
		<>
			<SettingsSection
				caption="When a run fails, Ryu can diagnose why and propose a fix. By default the fix is proposed in your Inbox for you to approve. Turn on auto-fix to let it retry on its own (bounded to a couple of attempts). The diagnosis runs through your gateway."
				title="Self-healing"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={healEnabled}
								disabled={!healingReady || busyKeys.includes("healing")}
								id="healing-enabled"
								onCheckedChange={handleHealEnabled}
							/>
						}
						description="On by default. Watch for failed runs and diagnose them; proposed fixes appear in your Inbox."
						title="Diagnose failed runs"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={healAutoDecide}
								disabled={
									!(healEnabled && healingReady) || busyKeys.includes("healing")
								}
								id="healing-auto-decide"
								onCheckedChange={handleHealAutoDecide}
							/>
						}
						description="Off by default. Apply the proposed fix and re-run automatically instead of asking first. Capped attempts and never re-heals its own retries."
						title="Auto-fix without asking"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const learnMore = (
		<>
			<SettingsSection title="Learn more">
				<SettingsCard>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Ryu is local-first and encrypted by default. Your prompts and agent
						content never leave your device except for the model call itself;
						content-free analytics and diagnostics are separate controls. For
						the full policy, see{" "}
						<button
							className="text-primary underline underline-offset-2"
							onClick={openDocs}
							type="button"
						>
							our privacy &amp; data page
						</button>
						.
					</p>
				</SettingsCard>
			</SettingsSection>
		</>
	);

	return (
		<div className="flex flex-col gap-6">
			{(privacyLoadError || healingLoadError) && (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm" role="alert">
						{privacyLoadError || healingLoadError}
					</p>
					<Button
						onClick={() => setLoadAttempt((attempt) => attempt + 1)}
						size="sm"
						variant="outline"
					>
						Retry privacy settings
					</Button>
				</SettingsCard>
			)}
			<SettingsSubpages
				backLabel="Privacy"
				intro={disclosureIntro}
				label="What leaves this device"
				outro={learnMore}
				pages={[
					{
						id: "device-permissions",
						title: "Device permissions",
						hint: "Notifications, microphone, screen recording, accessibility, and capture shortcuts.",
						icon: Wrench01Icon,
						tint: "teal",
						content: (
							<>
								<NotificationSettings />
								<DevicePermissionsSettings />
							</>
						),
					},
					{
						id: "sharing",
						title: "Usage & crash data",
						hint: "Anonymous analytics and community stats, account-linked profile activity, and crash reports.",
						icon: ChartLineData01Icon,
						tint: "blue",
						content: sharingPage,
					},
					{
						id: "diagnostics",
						title: "Diagnostics & support",
						hint: "Export traces to your own endpoint, or open a read-only support channel.",
						icon: Stethoscope02Icon,
						tint: "teal",
						content: diagnosticsPage,
					},
					{
						id: "healing",
						title: "Self-healing",
						hint: "Let Ryu diagnose a failed run and propose — or apply — a fix.",
						icon: Wrench01Icon,
						tint: "orange",
						content: healingPage,
					},
					{
						id: "security",
						title: "Custom app security",
						hint: "Set the default content security policy for custom apps.",
						icon: SecurityCheckIcon,
						tint: "red",
						content: (
							<CustomAppSecuritySettings key={target.url} target={target} />
						),
					},
				]}
				revealPageId={pendingSubpage}
			/>
		</div>
	);
}
