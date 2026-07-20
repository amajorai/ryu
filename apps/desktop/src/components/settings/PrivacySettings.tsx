// apps/desktop/src/components/settings/PrivacySettings.tsx
//
// The Privacy tab (P0 of docs/observability-analytics-support-access.md). It
// surfaces the four independent consent toggles from the §6 defaults table, each
// defaulting per that table — closed-UI product analytics + crash reports are
// opt-out (ON by default), while the data-plane OTLP diagnostics export and the
// local Core support-access channel are opt-in (OFF). A first-run disclosure
// notice is shown even though analytics defaults ON, so consent is informed.
//
// IMPORTANT: this unit ships the CONTROLS ONLY. No analytics SDK, crash reporter,
// or OTLP exporter is wired here — the toggles persist to Core's preferences
// (the canonical kebab keys) so later phases read one source of truth and so
// collection can never precede consent.

import { Alert01Icon, CloudServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { setAnalyticsEnabled } from "@/src/lib/analytics.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getHealingConfig,
	type HealingConfig,
	setHealingConfig,
} from "@/src/lib/api/healing.ts";
import {
	getCommunityStatsEnabled,
	getCrashReportsEnabled,
	getDiagnosticsExportEnabled,
	getDiagnosticsOtlpEndpoint,
	getLearningEnabled,
	getLearningSkillsEnabled,
	getProductAnalyticsEnabled,
	getSupportAccessLocalEnabled,
	getSupportAccessLocalExpiry,
	setCommunityStatsEnabled,
	setCrashReportsEnabled,
	setDiagnosticsExportEnabled,
	setDiagnosticsOtlpEndpoint,
	setLearningEnabled,
	setLearningSkillsEnabled,
	setProductAnalyticsEnabled,
	setSupportAccessLocalEnabled,
	setSupportAccessLocalExpiry,
} from "@/src/lib/api/preferences.ts";
import { setCrashReportingEnabled } from "@/src/lib/crash.ts";
import { AnalyticsInspector } from "./AnalyticsInspector.tsx";
import {
	DISCLOSURE_ACK_KEY,
	PRIVACY_DOCS_PATH as DOCS_PATH,
} from "./privacy-disclosure.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

// Hard-expiry duration options for a support-access grant. The §6 / §5.1 design
// keeps the support tier short (the impersonation tier uses <=1 hr); the user
// picks how long this scoped local channel stays open. A grant ALWAYS writes a
// non-zero expiry so Core's startup sweep can auto-disable it (a zero expiry
// would mean "never expires", which is not what a support grant should be).
const ONE_HOUR_MS = 60 * 60 * 1000;
const SUPPORT_DURATION_OPTIONS = [1, 8, 24] as const;
const DEFAULT_SUPPORT_DURATION_HOURS = 1;

export function PrivacySettings() {
	const activeNode = useActiveNode();
	// Memoize the target so it is stable across renders. A fresh object each
	// render would make the load effect (and every write callback) refire every
	// render, refetching all prefs and clobbering in-progress user input (e.g.
	// the OTLP endpoint field).
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
		}),
		[activeNode.url, activeNode.token]
	);

	const [productAnalytics, setProductAnalytics] = useState(true);
	const [communityStats, setCommunityStats] = useState(true);
	const [crashReports, setCrashReports] = useState(true);
	const [diagnosticsExport, setDiagnosticsExport] = useState(false);
	const [otlpEndpoint, setOtlpEndpoint] = useState("");
	const [supportAccess, setSupportAccess] = useState(false);
	const [supportExpiry, setSupportExpiry] = useState(0);
	const [learningEnabled, setLearningEnabledState] = useState(false);
	// The local skills loop defaults ON (on-device, inbox-gated); seed the
	// optimistic state to match so the toggle doesn't flicker off on first paint.
	const [skillsEnabled, setSkillsEnabledState] = useState(true);
	// Self-healing: master switch defaults ON, auto-decide defaults OFF (propose to
	// the inbox, the user disposes). Seeded to match Core's defaults.
	const [healEnabled, setHealEnabledState] = useState(true);
	const [healAutoDecide, setHealAutoDecideState] = useState(false);
	const [supportDurationHours, setSupportDurationHours] = useState(
		DEFAULT_SUPPORT_DURATION_HOURS
	);

	const [disclosureAck, setDisclosureAck] = useState<boolean>(
		() => localStorage.getItem(DISCLOSURE_ACK_KEY) === "true"
	);
	const acknowledgeDisclosure = useCallback(() => {
		setDisclosureAck(true);
		localStorage.setItem(DISCLOSURE_ACK_KEY, "true");
	}, []);

	// Load the self-healing config independently (its own endpoint, not a pref).
	useEffect(() => {
		let cancelled = false;
		getHealingConfig(target)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setHealEnabledState(cfg.enabled);
				setHealAutoDecideState(cfg.auto_decide);
			})
			.catch(() => {
				// Leave the optimistic defaults if healing config can't be read.
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const patchHealing = useCallback(
		async (
			patch: Partial<HealingConfig>,
			revert: () => void,
			label: string
		) => {
			try {
				await setHealingConfig(target, patch);
			} catch {
				revert();
				toast.error(`Couldn't save your ${label} choice`, {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleHealEnabled = useCallback(
		(next: boolean) => {
			setHealEnabledState(next); // optimistic
			void patchHealing(
				{ enabled: next },
				() => setHealEnabledState(!next),
				"self-healing"
			);
		},
		[patchHealing]
	);
	const handleHealAutoDecide = useCallback(
		(next: boolean) => {
			setHealAutoDecideState(next); // optimistic
			void patchHealing(
				{ auto_decide: next },
				() => setHealAutoDecideState(!next),
				"auto-fix"
			);
		},
		[patchHealing]
	);

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			getProductAnalyticsEnabled(target),
			getCommunityStatsEnabled(target),
			getCrashReportsEnabled(target),
			getDiagnosticsExportEnabled(target),
			getDiagnosticsOtlpEndpoint(target),
			getSupportAccessLocalEnabled(target),
			getSupportAccessLocalExpiry(target),
			getLearningEnabled(target),
			getLearningSkillsEnabled(target),
		]).then(
			([
				analytics,
				community,
				crashes,
				exportOn,
				endpoint,
				support,
				expiry,
				learning,
				skills,
			]) => {
				if (cancelled) {
					return;
				}
				setProductAnalytics(analytics);
				setCommunityStats(community);
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
				setSupportAccess(support);
				setSupportExpiry(expiry);
				setLearningEnabledState(learning);
				setSkillsEnabledState(skills);
			}
		);
		return () => {
			cancelled = true;
		};
	}, [target]);

	// Open the published privacy/data page in the browser so the reference is a
	// real, followable link rather than a dead file path.
	const openDocs = useCallback(() => {
		Promise.resolve(openExternal(`${FRONTEND_URL}${DOCS_PATH}`)).catch(
			() => undefined
		);
	}, []);

	const handleProductAnalytics = useCallback(
		async (next: boolean) => {
			setProductAnalytics(next);
			// Flip the live gate immediately (opt_out/opt_in the PostHog client) so
			// toggling off stops egress without waiting on the async Core write.
			setAnalyticsEnabled(next);
			try {
				await setProductAnalyticsEnabled(target, next);
			} catch {
				// The write never landed — revert the UI and the live gate so the
				// switch never shows a choice that wasn't saved.
				setProductAnalytics(!next);
				setAnalyticsEnabled(!next);
				toast.error("Couldn't save your analytics choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleCommunityStats = useCallback(
		async (next: boolean) => {
			setCommunityStats(next); // optimistic
			try {
				await setCommunityStatsEnabled(target, next);
			} catch {
				// The write never landed — revert so the switch never shows a choice
				// that wasn't saved.
				setCommunityStats(!next);
				toast.error("Couldn't save your community-stats choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleCrashReports = useCallback(
		async (next: boolean) => {
			setCrashReports(next);
			// Flip the live runtime gate immediately (beforeSend drops events when
			// off) so toggling off stops egress without waiting on the async Core
			// write. Restart-to-apply for the Rust panic tier (Core/Gateway).
			setCrashReportingEnabled(next);
			try {
				await setCrashReportsEnabled(target, next);
			} catch {
				setCrashReports(!next);
				setCrashReportingEnabled(!next);
				toast.error("Couldn't save your crash-report choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleDiagnosticsExport = useCallback(
		async (next: boolean) => {
			setDiagnosticsExport(next);
			try {
				await setDiagnosticsExportEnabled(target, next);
			} catch {
				setDiagnosticsExport(!next);
				toast.error("Couldn't save your diagnostics-export choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleOtlpEndpoint = useCallback((e: ChangeEvent<HTMLInputElement>) => {
		setOtlpEndpoint(e.target.value);
	}, []);
	const commitOtlpEndpoint = useCallback(async () => {
		try {
			await setDiagnosticsOtlpEndpoint(target, otlpEndpoint);
		} catch {
			toast.error("Couldn't save the diagnostics endpoint", {
				description: "Check your connection and try again.",
			});
		}
	}, [otlpEndpoint, target]);
	const handleSupportAccess = useCallback(
		async (next: boolean) => {
			setSupportAccess(next);
			if (next) {
				// A grant ALWAYS writes a non-zero hard expiry (now + chosen
				// duration) so Core's startup sweep can auto-disable it. Write the
				// expiry BEFORE the enabled flag so the grant is never momentarily
				// "on with no expiry".
				const previousExpiry = supportExpiry;
				const expiry = Date.now() + supportDurationHours * ONE_HOUR_MS;
				setSupportExpiry(expiry);
				try {
					await setSupportAccessLocalExpiry(target, expiry);
					await setSupportAccessLocalEnabled(target, true);
				} catch {
					// Neither write landed — revert so the switch doesn't imply a
					// grant that was never saved.
					setSupportAccess(false);
					setSupportExpiry(previousExpiry);
					toast.error("Couldn't grant support access", {
						description: "Check your connection and try again.",
					});
				}
			} else {
				// Ending the grant flips the enabled flag off; the expiry is left
				// as-is (the enabled flag is the live gate, the sweep handles the
				// rest).
				try {
					await setSupportAccessLocalEnabled(target, false);
				} catch {
					setSupportAccess(true);
					toast.error("Couldn't end support access", {
						description: "Check your connection and try again.",
					});
				}
			}
		},
		[supportDurationHours, supportExpiry, target]
	);
	const handleSupportDuration = useCallback((value: string | null) => {
		const hours = Number(value);
		setSupportDurationHours(
			Number.isFinite(hours) && hours > 0
				? hours
				: DEFAULT_SUPPORT_DURATION_HOURS
		);
	}, []);
	const handleLearning = useCallback(
		async (next: boolean) => {
			setLearningEnabledState(next); // optimistic
			try {
				await setLearningEnabled(target, next);
			} catch {
				setLearningEnabledState(!next);
				toast.error("Couldn't save your learning choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);
	const handleSkills = useCallback(
		async (next: boolean) => {
			setSkillsEnabledState(next); // optimistic
			try {
				await setLearningSkillsEnabled(target, next);
			} catch {
				setSkillsEnabledState(!next);
				toast.error("Couldn't save your skill-learning choice", {
					description: "Check your connection and try again.",
				});
			}
		},
		[target]
	);

	return (
		<div className="space-y-6">
			{disclosureAck ? null : (
				<SettingsCard className="flex flex-col gap-3 border-primary/40">
					<div className="flex items-start gap-2.5">
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 opacity-70"
							icon={Alert01Icon}
						/>
						<div className="space-y-1.5">
							<p className="font-medium text-sm">How Ryu handles your data</p>
							<p className="text-muted-foreground text-xs leading-relaxed">
								Anonymous, content-free product analytics and crash reports are
								on by default so we can fix what breaks and improve the app.
								They never include your prompts, conversations, files, or any
								agent content, and they use a random install ID that is not
								linked to your account. Your local data plane (Core and the
								Gateway) sends nothing off your device unless you turn on
								diagnostics export below. You can change any of these any time.
								See{" "}
								<button
									className="text-primary underline underline-offset-2"
									onClick={openDocs}
									type="button"
								>
									our privacy &amp; data page
								</button>{" "}
								for the full breakdown.
							</p>
						</div>
					</div>
					<div className="flex justify-end">
						<Button onClick={acknowledgeDisclosure} size="sm">
							Got it
						</Button>
					</div>
				</SettingsCard>
			)}

			<SettingsSection
				caption="On by default. Anonymous, content-free usage events (which screens you open, whether onboarding finished, install success) help us improve Ryu. Never includes prompts, conversations, files, or any agent content; identified only by a random install ID, not your account."
				title="Product analytics"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={productAnalytics}
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
								id="community-stats"
								onCheckedChange={handleCommunityStats}
							/>
						}
						title="Share anonymous community stats"
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
								id="crash-reports"
								onCheckedChange={handleCrashReports}
							/>
						}
						title="Send crash and error reports"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Off by default. When on, Core and the Gateway export their local run-trace and audit records (already content-free: hashed args, redacted keys) to an OpenTelemetry (OTLP) endpoint you choose. With no endpoint set, nothing is exported even when this is on. The destination is fully swappable: point it at Axiom, Grafana, a self-hosted Collector, or anything OTLP-native."
				title="Diagnostics export"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={diagnosticsExport}
								id="diagnostics-export"
								onCheckedChange={handleDiagnosticsExport}
							/>
						}
						title="Export local diagnostics over OTLP"
					/>
					<SettingsItem
						description="OTLP endpoint, e.g. https://api.axiom.co or a local Collector. Leave blank to keep diagnostics local-only."
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
							onBlur={commitOtlpEndpoint}
							onChange={handleOtlpEndpoint}
							placeholder="https://api.axiom.co"
							value={otlpEndpoint}
						/>
					</SettingsItem>
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
								id="support-access-local"
								onCheckedChange={handleSupportAccess}
							/>
						}
						description={
							supportAccess && supportExpiry > 0
								? `Active until ${new Date(supportExpiry).toLocaleString()}. Diagnostics are sent only over your private, encrypted connection.`
								: "Requires your private, encrypted connection to be turned on so diagnostics stay on your own network."
						}
						title="Grant local support access"
					/>
					<SettingsItem
						description="Access turns itself off after this, and is re-checked each time Ryu restarts. You can also end it any time from the banner."
						title="Access duration"
					>
						<Select
							disabled={supportAccess}
							items={SUPPORT_DURATION_OPTIONS.map((hours) => ({
								label: hours === 1 ? "1 hour" : `${hours} hours`,
								value: String(hours),
							}))}
							onValueChange={handleSupportDuration}
							value={String(supportDurationHours)}
						>
							<SelectTrigger className="h-9 w-40 text-sm">
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
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Ryu can grow with you by learning from your conversations. This is split into two levels so you can keep the private, on-device part on while opting into the heavier part only if you want. You can leave out any individual conversation, and excluded conversations are never used."
				title="Learn from my conversations"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={skillsEnabled}
								id="learning-skills-enabled"
								onCheckedChange={handleSkills}
							/>
						}
						description="On by default. Ryu distills reusable skills from your chats — entirely on this device — and proposes them in your Inbox for you to approve before they go live. No conversation text ever leaves your machine."
						title="Learn skills from my chats"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={learningEnabled}
								id="learning-enabled"
								onCheckedChange={handleLearning}
							/>
						}
						description="Off by default. Also rate your conversations with a stronger model and, on a device with a capable graphics card, fine-tune your local model on your best ones. Rating sends conversation text to that model, which may run in the cloud — so this stays opt-in."
						title="Train my local model"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="When a run fails, Ryu can diagnose why and propose a fix. By default the fix is proposed in your Inbox for you to approve — turn on auto-fix to let it retry on its own (bounded to a couple of attempts). The diagnosis runs through your gateway."
				title="Self-healing"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={healEnabled}
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
								disabled={!healEnabled}
								id="healing-auto-decide"
								onCheckedChange={handleHealAutoDecide}
							/>
						}
						description="Off by default. Apply the proposed fix and re-run automatically instead of asking first. Capped attempts and never re-heals its own retries."
						title="Auto-fix without asking"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Learn more">
				<SettingsCard>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Ryu is local-first and encrypted by default. The data plane (your
						prompts and agent content) never leaves your device except for the
						model call itself. For the full policy, see{" "}
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
		</div>
	);
}
