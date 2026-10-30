/* @jsxImportSource @opentui/react */

import { TextInput } from "@/components/ui/text-input.tsx";
import type { useTheme } from "@/components/ui/theme-provider.tsx";
import { type PrivacyPreferences, ROWS } from "./privacy-preferences.ts";

/** One row per privacy preference, with the selected row's description. */
export function PrivacyRows({
	commitEndpoint,
	editingEndpoint,
	endpointDraft,
	preferences,
	selectedIndex,
	setEndpointDraft,
	supportDurationHours,
	supportState,
	themeColor,
}: {
	commitEndpoint: (value: string) => void;
	editingEndpoint: boolean;
	endpointDraft: string;
	preferences: PrivacyPreferences;
	selectedIndex: number;
	setEndpointDraft: (value: string) => void;
	supportDurationHours: number;
	supportState: string;
	themeColor: ReturnType<typeof useTheme>["colors"];
}) {
	return (
		<>
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
		</>
	);
}

/** Save status, errors, key hints, and the Desktop disclosure pointer. */
export function PrivacyFooter({
	busy,
	editingEndpoint,
	error,
	notice,
	themeColor,
}: {
	busy: boolean;
	editingEndpoint: boolean;
	error: string | null;
	notice: string | null;
	themeColor: ReturnType<typeof useTheme>["colors"];
}) {
	return (
		<>
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
		</>
	);
}
