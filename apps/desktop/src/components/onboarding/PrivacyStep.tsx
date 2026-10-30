// The onboarding privacy step. It is deliberately the same consent toggles the
// Settings → Privacy panel leads with (product analytics, community stats, crash
// reports, diagnostics export) driven through the *same* Core preferences and
// runtime gates, so whatever the user picks here is already persisted by the
// time onboarding finishes — there is no separate onboarding privacy state to
// reconcile later.
//
// Defaults match the §6 consent table: product analytics, community stats, and
// crash reports are opt-out (ON by default), diagnostics export is opt-in (OFF).
// Consent is still informed here — each row explains exactly what it sends — and
// every toggle flips the live runtime gate so a choice takes effect immediately.
//
// This unit owns the onboarding explanation and controls only, exactly like
// PrivacySettings: no analytics SDK, crash reporter, or OTLP exporter is wired
// here.

import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	acknowledgePrivacyDisclosure,
	PRIVACY_DOCS_PATH,
} from "@/src/components/settings/privacy-disclosure-state.ts";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { setAnalyticsEnabled } from "@/src/lib/analytics.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getCommunityStatsEnabled,
	getCrashReportsEnabled,
	getDiagnosticsExportEnabled,
	getProductAnalyticsEnabled,
	setCommunityStatsEnabled,
	setCrashReportsEnabled,
	setDiagnosticsExportEnabled,
	setProductAnalyticsEnabled,
} from "@/src/lib/api/preferences.ts";
import { setCrashReportingEnabled } from "@/src/lib/crash.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

interface PrivacyStepProps {
	/** Onboarding is finishing; the step locks so the user can't double-submit. */
	busy?: boolean;
	onContinue: () => void;
}

export function PrivacyStep({ busy = false, onContinue }: PrivacyStepProps) {
	const activeNode = useActiveNode();
	// Memoize the target so it is stable across renders. A fresh object each
	// render would make the load effect (and every write callback) refire every
	// render, refetching all prefs and clobbering in-progress user input.
	const target: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);

	const [productAnalytics, setProductAnalytics] = useState(true);
	const [communityStats, setCommunityStats] = useState(true);
	const [crashReports, setCrashReports] = useState(true);
	const [diagnosticsExport, setDiagnosticsExport] = useState(false);

	const [readyTarget, setReadyTarget] = useState<ApiTarget | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	type Choice = "analytics" | "community" | "crashes" | "export";
	const [failedWrite, setFailedWrite] = useState<{
		choice: Choice;
		next: boolean;
	} | null>(null);
	const acknowledged = useRef({
		analytics: true,
		community: true,
		crashes: true,
		export: false,
	});
	const currentTarget = useRef(target);
	currentTarget.current = target;
	const mounted = useRef(false);
	const pending = useRef<object | null>(null);
	const ready = useRef<ApiTarget | null>(null);
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const failed = useRef<typeof failedWrite>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			ready.current = null;
			pending.current = null;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		ready.current = null;
		pending.current = null;
		failed.current = null;
		setReadyTarget(null);
		setSaving(false);
		setFailedWrite(null);
		setLoadError(null);
		Promise.all([
			getProductAnalyticsEnabled(target),
			getCommunityStatsEnabled(target),
			getCrashReportsEnabled(target),
			getDiagnosticsExportEnabled(target),
		])
			.then(([analytics, community, crashes, exportOn]) => {
				if (cancelled || !mounted.current || currentTarget.current !== target) {
					return;
				}
				acknowledged.current = {
					analytics,
					community,
					crashes,
					export: exportOn,
				};
				setProductAnalytics(analytics);
				setCommunityStats(community);
				setCrashReports(crashes);
				setDiagnosticsExport(exportOn);
				setAnalyticsEnabled(analytics);
				setCrashReportingEnabled(crashes);
				ready.current = target;
				setReadyTarget(target);
			})
			.catch(() => {
				if (cancelled || !mounted.current || currentTarget.current !== target) {
					return;
				}
				setLoadError(
					"Couldn't load your privacy choices. Check your connection and retry."
				);
			});
		return () => {
			cancelled = true;
		};
	}, [target, loadAttempt]);

	const saveChoice = useCallback(
		async (choice: Choice, next: boolean, retry = false) => {
			if (
				!mounted.current ||
				currentTarget.current !== target ||
				ready.current !== target ||
				pending.current ||
				busyRef.current ||
				(failed.current && !retry)
			) {
				return;
			}
			const operation = {};
			pending.current = operation;
			setSaving(true);
			failed.current = null;
			setFailedWrite(null);
			const previous = acknowledged.current[choice];
			const setters = {
				analytics: setProductAnalytics,
				community: setCommunityStats,
				crashes: setCrashReports,
				export: setDiagnosticsExport,
			};
			const writes = {
				analytics: setProductAnalyticsEnabled,
				community: setCommunityStatsEnabled,
				crashes: setCrashReportsEnabled,
				export: setDiagnosticsExportEnabled,
			};
			const titles = {
				analytics: "Couldn't save your analytics choice",
				community: "Couldn't save your community-stats choice",
				crashes: "Couldn't save your crash-report choice",
				export: "Couldn't save your diagnostics-export choice",
			};
			const apply = (value: boolean) => {
				setters[choice](value);
				// Opt-out stops the live gate immediately, before Core acknowledges.
				if (choice === "analytics") {
					setAnalyticsEnabled(value);
				}
				if (choice === "crashes") {
					setCrashReportingEnabled(value);
				}
			};
			const current = () =>
				mounted.current &&
				currentTarget.current === target &&
				pending.current === operation;
			apply(next);
			try {
				await writes[choice](target, next);
				if (current()) {
					acknowledged.current[choice] = next;
				}
			} catch {
				if (!current()) {
					return;
				}
				apply(previous);
				const receipt = { choice, next };
				failed.current = receipt;
				setFailedWrite(receipt);
				toast.error({
					title: titles[choice],
					description:
						"Your previous choice is restored. Check your connection and retry saving.",
				});
			} finally {
				if (current()) {
					pending.current = null;
					setSaving(false);
				}
			}
		},
		[target]
	);
	const handleProductAnalytics = useCallback(
		(next: boolean) => saveChoice("analytics", next),
		[saveChoice]
	);
	const handleCommunityStats = useCallback(
		(next: boolean) => saveChoice("community", next),
		[saveChoice]
	);
	const handleCrashReports = useCallback(
		(next: boolean) => saveChoice("crashes", next),
		[saveChoice]
	);
	const handleDiagnosticsExport = useCallback(
		(next: boolean) => saveChoice("export", next),
		[saveChoice]
	);
	const locked =
		busy || readyTarget !== target || saving || failedWrite !== null;

	// Open the published privacy/data page in the browser so the reference is a
	// real, followable link rather than a dead file path.
	const openDocs = useCallback(() => {
		Promise.resolve(openExternal(`${FRONTEND_URL}${PRIVACY_DOCS_PATH}`)).catch(
			() => undefined
		);
	}, []);

	const handleContinue = useCallback(() => {
		if (
			busyRef.current ||
			ready.current !== target ||
			currentTarget.current !== target ||
			pending.current ||
			failed.current
		) {
			return;
		}
		acknowledgePrivacyDisclosure();
		onContinue();
	}, [onContinue, target]);

	return (
		<ActivationStepShell
			subtitle="Change these choices any time in Settings."
			title="Your privacy choices"
		>
			<div className="flex flex-col gap-4" data-testid="onboarding-final-step">
				{loadError ? (
					<div className="flex items-center justify-between gap-6" role="alert">
						<p className="text-sm">{loadError}</p>
						<Button
							onClick={() => {
								ready.current = null;
								setReadyTarget(null);
								setLoadError(null);
								setLoadAttempt((attempt) => attempt + 1);
							}}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</div>
				) : readyTarget === target ? null : (
					<p aria-live="polite" className="text-muted-foreground text-sm">
						Loading privacy choices…
					</p>
				)}
				{failedWrite ? (
					<div className="flex items-center justify-between gap-6" role="alert">
						<p className="text-sm">
							Couldn't save your privacy choice. Your previous choice is
							restored.
						</p>
						<Button
							disabled={busy || saving}
							onClick={() =>
								void saveChoice(failedWrite.choice, failedWrite.next, true)
							}
							size="sm"
							variant="outline"
						>
							Retry saving
						</Button>
					</div>
				) : null}
				{saving ? (
					<p aria-live="polite" className="text-muted-foreground text-sm">
						Saving privacy choice…
					</p>
				) : null}

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Product analytics"
								checked={productAnalytics}
								disabled={locked}
								id="onboarding-product-analytics"
								onCheckedChange={handleProductAnalytics}
							/>
						}
						description="Anonymous product events; no prompts or agent content."
						title="Product analytics"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Community stats"
								checked={communityStats}
								disabled={locked}
								id="onboarding-community-stats"
								onCheckedChange={handleCommunityStats}
							/>
						}
						description="Anonymous token-savings totals for the community."
						title="Community stats"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Crash reports"
								checked={crashReports}
								disabled={locked}
								id="onboarding-crash-reports"
								onCheckedChange={handleCrashReports}
							/>
						}
						description="Scrubbed error stacks; no prompts or content."
						title="Crash reports"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Diagnostics export"
								checked={diagnosticsExport}
								disabled={locked}
								id="onboarding-diagnostics-export"
								onCheckedChange={handleDiagnosticsExport}
							/>
						}
						description="Off by default. With an endpoint set, redacted traces go there. The same opt-in sends a small Core/Gateway summary from Ryu Cloud-enrolled nodes to Ryu Axiom."
						title="Diagnostics export"
					/>
				</SettingsGroup>

				<OnboardingActions>
					<OnboardingCta
						data-testid="onboarding-privacy-details"
						onClick={openDocs}
						tone="secondary"
					>
						Full privacy details
					</OnboardingCta>
					<OnboardingCta
						data-testid="onboarding-final-continue"
						disabled={locked}
						onClick={handleContinue}
					>
						{busy ? "Finishing…" : "Get started"}
					</OnboardingCta>
				</OnboardingActions>
			</div>
		</ActivationStepShell>
	);
}
