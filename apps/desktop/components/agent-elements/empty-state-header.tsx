"use client";

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { type ReactNode, useState } from "react";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { ManageModelsButton } from "@/components/agent-elements/input/manage-models-button.tsx";
import { ProjectCommandDialog } from "@/src/components/chat/ProjectPicker.tsx";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import styles from "./empty-state-header.module.css";

const TRAILING_QUESTION = /\?\s*$/;
const PATH_SEPARATOR = /[\\/]/;

/** What the empty-state logo represents: a single engine, a custom uploaded
 *  agent image, or a fanned stack of engines (the Ryu flagship "home" identity,
 *  or a team's members). */
export type EmptyStateLogo =
	| { kind: "single"; engine: string | null }
	| { kind: "image"; url: string }
	| { kind: "glyph"; glyph: Exclude<GlyphValue, null> }
	| { kind: "stack"; engines: (string | null)[] };

/** Render the empty-state mark for the active target. */
function EmptyStateMark({
	logo,
	hovered,
}: {
	logo: EmptyStateLogo;
	hovered: boolean;
}) {
	if (logo.kind === "glyph") {
		return (
			<GlyphDisplay
				alt="Agent avatar"
				className="size-14 object-contain"
				corners="circle"
				size={56}
				value={logo.glyph}
			/>
		);
	}
	if (logo.kind === "image") {
		return (
			// Tauri/Vite app, no next/image; avatar is an inline data URL
			// sized via the `size-14` class
			<img
				alt="Agent avatar"
				className="size-14 rounded-full object-cover"
				src={logo.url}
			/>
		);
	}
	if (logo.kind === "single") {
		return (
			<AgentLogo className="object-contain" engine={logo.engine} size="56px" />
		);
	}
	return <FannedAgentLogos engines={logo.engines} hovered={hovered} />;
}

/**
 * A team's member logos as bare marks fanned along an arc. They sit with a
 * comfortable gap at rest and spread further apart on hover — no card chrome.
 */
function FannedAgentLogos({
	engines,
	hovered,
}: {
	engines: (string | null)[];
	hovered: boolean;
}) {
	const shown = engines.slice(0, 5);
	const center = (shown.length - 1) / 2;
	return (
		<div className={styles.fan} data-hovered={hovered}>
			{shown.map((engine, i) => {
				const offset = i - center;
				return (
					<span
						className={styles.fanMark}
						data-offset={offset}
						key={`${engine ?? "ryu"}-${offset}`}
					>
						<AgentLogo className="object-contain" engine={engine} size="44px" />
					</span>
				);
			})}
		</div>
	);
}

export interface EmptyStateHeaderProps {
	/** Keep the managed Bot mark informative without exposing a settings menu. */
	interactiveLogo?: boolean;
	logo: EmptyStateLogo;
	/**
	 * The composer's composed Agent · Model · Approval/Thinking sections (from
	 * `useComposerAgentControls().sections`). The logo opens the SAME dropdown as
	 * the composer's settings menu — not just an agent list — so a mode/thinking
	 * level can be picked straight from the empty state.
	 */
	/**
	 * The universal picker body (from `useComposerAgentControls().renderBody`). When
	 * provided, the logo opens the SAME grouped `Ryu (providers nested) · External
	 * Agents` dropdown as the composer. Omit to fall back to the sibling-section list.
	 */
	renderBody?: (close: () => void) => ReactNode;
	sections: ComposerSettingsSection[];
	/** Build exposes project context here; Bot keeps the empty state focused. */
	showProjectPicker?: boolean;
	title?: string;
}

/**
 * The chat empty state: an editable-feeling heading "What are we doing in
 * <folder>", with a clickable agent logo below that opens the same
 * Agent · Model · Thinking dropdown as the composer. The folder name is a
 * dotted-underlined trigger that opens the project folder selector.
 */
export function EmptyStateHeader({
	interactiveLogo = true,
	title = "What are we doing?",
	logo,
	sections,
	renderBody,
	showProjectPicker = true,
}: EmptyStateHeaderProps) {
	const [folderOpen, setFolderOpen] = useState(false);
	const [hovered, setHovered] = useState(false);
	const { folder } = useWorkspaceStore();
	const folderName = showProjectPicker
		? folder?.split(PATH_SEPARATOR).at(-1)
		: null;

	// Strip a trailing "?" so "What are we doing in backstage" reads right
	// once a folder is appended; keep it as plain title when no folder is set.
	const titleText = title.replace(TRAILING_QUESTION, "");

	return (
		<div className="flex flex-col items-center">
			<div className="mb-7 flex flex-wrap items-baseline justify-center text-center">
				<h1 className={styles.heading}>
					{folderName ? `${titleText} in ` : title}
				</h1>
				{folderName && (
					<>
						<button
							aria-haspopup="dialog"
							aria-label="Select project folder"
							className={styles.folderTrigger}
							data-open={folderOpen}
							onClick={() => setFolderOpen(true)}
							title={folder ?? undefined}
							type="button"
						>
							<span className="max-w-48 truncate">{folderName}</span>
						</button>
						<ProjectCommandDialog
							onOpenChange={setFolderOpen}
							open={folderOpen}
						/>
						<h1 className={styles.heading}>?</h1>
					</>
				)}
			</div>

			{/* The logo opens the composer's full Agent · Model · Thinking dropdown
			    (the shared ComposerSettingsMenu), not just an agent list — same
			    sections, same behaviour, behind the big empty-state mark. */}
			{interactiveLogo ? (
				<ComposerSettingsMenu
					align="center"
					footer={(close) => <ManageModelsButton close={close} />}
					renderBody={renderBody}
					sections={sections}
					side="bottom"
					trigger={
						<button
							aria-label="Agent, model and mode settings"
							className={styles.logoTrigger}
							onMouseEnter={() => setHovered(true)}
							onMouseLeave={() => setHovered(false)}
							type="button"
						>
							<EmptyStateMark hovered={hovered} logo={logo} />
						</button>
					}
				/>
			) : (
				<div
					aria-hidden="true"
					className="relative top-5 z-0 flex items-center justify-center rounded-2xl p-1"
					onMouseEnter={() => setHovered(true)}
					onMouseLeave={() => setHovered(false)}
				>
					<EmptyStateMark hovered={hovered} logo={logo} />
				</div>
			)}
		</div>
	);
}
