// apps/desktop/src/components/settings/PrivacySettings-diagnostics-page.tsx
//
// The "Diagnostics & support" sub-page of the Privacy tab.

import { Alert01Icon, CloudServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatDateTime } from "@/src/lib/timezone.ts";
import {
	CONTENT_MODE_OPTIONS,
	EXPORTER_FIELD_COPY,
	EXPORTER_PRESET_OPTIONS,
	SUPPORT_DURATION_OPTIONS,
} from "./PrivacySettings-options.ts";
import type { PrivacyPreferences } from "./PrivacySettings-preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function DiagnosticsPage({
	busyKeys,
	prefs,
	privacyReady,
}: {
	busyKeys: string[];
	prefs: PrivacyPreferences;
	privacyReady: boolean;
}) {
	const {
		commitExporterField,
		commitOtlpEndpoint,
		contentMode,
		diagnosticsExport,
		exporter,
		handleContentMode,
		handleDiagnosticsExport,
		handleExporterField,
		handleExporterPreset,
		handleOtlpEndpoint,
		handleSendTestSpan,
		handleSupportAccess,
		handleSupportDuration,
		otlpEndpoint,
		supportAccess,
		supportDurationHours,
		supportExpiry,
		testSpanBusy,
	} = prefs;
	const tl = useLiteralMessages();
	return (
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
								? tl(
										"Active until {expiry}. Diagnostics are sent only over your private, encrypted connection.",
										{ expiry: formatDateTime(supportExpiry) }
									)
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
									label: tl("{hours, plural, one {# hour} other {# hours}}", {
										hours,
									}),
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
											{tl("{hours, plural, one {# hour} other {# hours}}", {
												hours,
											})}
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
}
