/* @jsxImportSource @opentui/react */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { PRODUCT_MODES, type ProductMode } from "../../core/productMode.ts";
import { modalRowId, useModalActiveRow } from "../../ui/Modal.tsx";
import type { OverlayBodyProps, OverlayModule } from "../registry.ts";
import { registerOverlay } from "../registry.ts";

const MODE_COPY = {
	bot: {
		description:
			"Chat through this Core, with managed routing when your plan and workspace allow it.",
		label: "Bot",
	},
	console: {
		description: "Core overview and Gateway controls.",
		label: "Agent",
	},
	os: {
		description: "Launch terminal-compatible Apps and workspace views.",
		label: "OS",
	},
} satisfies Record<ProductMode, { description: string; label: string }>;

const MODES_WITHOUT_CONSOLE: readonly ProductMode[] = ["bot", "os"];

function ProductModeBody({ close }: OverlayBodyProps) {
	const theme = useTheme();
	const {
		checkConsoleAccess,
		consoleAccessStatus,
		consoleAccessTargetKey,
		effectiveMode,
		issue,
		modeStatus,
		retry,
		selectMode,
	} = useCliProductMode();
	const availableModes =
		consoleAccessStatus === "available" ? PRODUCT_MODES : MODES_WITHOUT_CONSOLE;
	const [index, setIndex] = useState(() =>
		Math.max(0, availableModes.indexOf(effectiveMode))
	);
	// The host Modal scrolls when the cards do not fit; keep the selection shown.
	useModalActiveRow(modalRowId(`mode-${availableModes[index] ?? "none"}`));
	useEffect(() => {
		void checkConsoleAccess();
	}, [checkConsoleAccess, consoleAccessTargetKey]);
	useEffect(() => {
		setIndex(Math.max(0, availableModes.indexOf(effectiveMode)));
	}, [availableModes, effectiveMode]);

	const select = (mode: ProductMode) => {
		void selectMode(mode).then((ready) => {
			if (ready) {
				close();
			}
		});
	};

	useKeyboard((key: KeyEvent) => {
		if (key.name === "up" || key.name === "k") {
			setIndex((current) => Math.max(0, current - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((current) => Math.min(availableModes.length - 1, current + 1));
		} else if (key.name === "return") {
			const mode = availableModes[index];
			if (mode) {
				select(mode);
			}
		} else if (key.name === "r" && issue) {
			void retry().then((ready) => {
				if (ready) {
					close();
				}
			});
		} else if (key.name === "r" && consoleAccessStatus === "denied") {
			void checkConsoleAccess();
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={theme.colors.mutedForeground}>
				Choose the terminal surface. This preference belongs to this CLI
				profile.
			</text>
			{availableModes.map((mode, optionIndex) => {
				const selected = optionIndex === index;
				const current = effectiveMode === mode;
				return (
					<box
						borderColor={
							selected ? theme.colors.focusRing : theme.colors.border
						}
						borderStyle={selected ? "rounded" : "single"}
						flexDirection="row"
						gap={1}
						id={modalRowId(`mode-${mode}`)}
						key={mode}
						onMouseDown={() => select(mode)}
						paddingLeft={1}
						paddingRight={1}
					>
						<text
							fg={
								selected ? theme.colors.primary : theme.colors.mutedForeground
							}
						>
							{selected ? "›" : " "}
						</text>
						<text
							fg={selected ? theme.colors.primary : theme.colors.foreground}
						>
							<b>{MODE_COPY[mode].label}</b>
						</text>
						<text fg={theme.colors.mutedForeground}>
							{MODE_COPY[mode].description}
						</text>
						{current ? <text fg={theme.colors.success}>[active]</text> : null}
					</box>
				);
			})}
			{consoleAccessStatus === "checking" ||
			consoleAccessStatus === "unknown" ? (
				<text fg={theme.colors.mutedForeground}>Checking Agent access…</text>
			) : null}
			{modeStatus === "checking" || modeStatus === "switching" ? (
				<text fg={theme.colors.mutedForeground}>
					{modeStatus === "checking"
						? "Checking access…"
						: "Checking access and switching…"}
				</text>
			) : null}
			{issue ? (
				<box
					borderColor={theme.colors.error}
					borderStyle="single"
					paddingLeft={1}
					paddingRight={1}
				>
					<text fg={theme.colors.error}>{issue.message}</text>
					<text fg={theme.colors.mutedForeground}>
						{issue.kind === "cloud-lane-write-failed"
							? "Press r to retry the managed chat setup."
							: "Press r to retry. For account billing, open Settings → Account."}
					</text>
				</box>
			) : null}
			{consoleAccessStatus === "denied" && !issue ? (
				<text fg={theme.colors.mutedForeground}>
					Agent is hidden until access on this node can be verified. Press r to
					recheck.
				</text>
			) : null}
			<text fg={theme.colors.mutedForeground}>
				↑/↓ move · Enter switch · r retry · Esc close · Ctrl+Shift+M reopen
			</text>
			<text fg={theme.colors.mutedForeground}>
				Desktop Dock, live windows, wallpaper, and Tauri OS permission prompts
				remain in Desktop.
			</text>
		</box>
	);
}

export const productModeOverlay: OverlayModule = {
	Body: ProductModeBody,
	id: "product-mode",
	title: "Ryu product mode",
};

registerOverlay(productModeOverlay);
