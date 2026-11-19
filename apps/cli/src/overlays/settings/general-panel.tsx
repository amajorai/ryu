/* @jsxImportSource @opentui/react */
// Settings > General: the Core node this client talks to, its auth state, and
// the startup realm preference (left/right or click; applies on next launch).

import { useKeyboard } from "@opentui/react";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { STARTUP_REALM_OPTIONS } from "../../core/productMode.ts";
import { tr } from "../../i18n/translate.ts";

export function GeneralPanel() {
	const { url, token } = useCore();
	const theme = useTheme();
	// The card is taller than the Settings body on short terminals; scroll it
	// instead of letting Yoga shrink its rows onto each other.
	return (
		<scrollbox flexGrow={1}>
			<Card subtitle="Ryu Core node" title="General">
				<InfoLine
					label="Node"
					value={url}
					valueColor={theme.colors.foreground}
				/>
				<InfoLine
					label="Auth"
					value={token ? tr("token set") : tr("no token")}
					valueColor={token ? theme.colors.success : theme.colors.warning}
				/>
				<StartupRealmSetting />
				<box marginTop={1}>
					<text fg={theme.colors.mutedForeground}>
						Node connection is managed from the Gateway overlay and the node
						picker.
					</text>
				</box>
			</Card>
		</scrollbox>
	);
}

function StartupRealmSetting() {
	const { modePreference, setStartupRealm, startupRealmSaveError } =
		useCliProductMode();
	const theme = useTheme();
	const selectedIndex = Math.max(
		0,
		STARTUP_REALM_OPTIONS.findIndex(
			(option) => option.value === modePreference.startupRealm
		)
	);
	useKeyboard((key) => {
		if (key.name !== "left" && key.name !== "right") {
			return;
		}
		const direction = key.name === "right" ? 1 : -1;
		const nextIndex =
			(selectedIndex + direction + STARTUP_REALM_OPTIONS.length) %
			STARTUP_REALM_OPTIONS.length;
		const option = STARTUP_REALM_OPTIONS[nextIndex];
		if (option) {
			setStartupRealm(option.value);
		}
	});

	return (
		<box flexDirection="column" gap={1} marginTop={1}>
			<text fg={theme.colors.mutedForeground}>Startup realm</text>
			{/* Wrap the choices in a narrow pane rather than crushing each one. */}
			<box flexDirection="row" flexWrap="wrap" gap={1}>
				{STARTUP_REALM_OPTIONS.map((option, optionIndex) => {
					const selected = selectedIndex === optionIndex;
					return (
						<box
							borderColor={
								selected ? theme.colors.focusRing : theme.colors.border
							}
							borderStyle={selected ? "rounded" : "single"}
							key={option.value}
							onMouseDown={() => setStartupRealm(option.value)}
							paddingLeft={1}
							paddingRight={1}
						>
							<text
								fg={selected ? theme.colors.primary : theme.colors.foreground}
							>
								{selected ? `› ${option.label}` : option.label}
							</text>
						</box>
					);
				})}
			</box>
			<text fg={theme.colors.mutedForeground}>
				← / → or click · applies on next launch
			</text>
			{startupRealmSaveError ? (
				<text fg={theme.colors.error}>{startupRealmSaveError}</text>
			) : null}
		</box>
	);
}

function InfoLine({
	label,
	value,
	valueColor,
}: {
	label: string;
	value: string;
	valueColor: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{label.padEnd(6, " ")}</text>
			<text fg={valueColor}>{value}</text>
		</box>
	);
}
