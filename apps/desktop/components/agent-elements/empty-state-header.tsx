"use client";

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { type ReactNode, useState } from "react";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { PickerSettingsMenu } from "@/components/agent-elements/input/manage-models-button.tsx";
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

/** Render the empty-state mark for the active target: one 32px mark. */
function EmptyStateMark({ logo }: { logo: EmptyStateLogo }) {
	if (logo.kind === "glyph") {
		return (
			<GlyphDisplay
				alt="Agent avatar"
				className="size-8 object-contain"
				corners="circle"
				size={32}
				value={logo.glyph}
			/>
		);
	}
	if (logo.kind === "image") {
		return (
			// Tauri/Vite app, no next/image; avatar is an inline data URL
			// sized via the `size-8` class
			<img
				alt="Agent avatar"
				className="size-8 rounded-full object-cover"
				src={logo.url}
			/>
		);
	}
	if (logo.kind === "single") {
		return (
			<AgentLogo className="object-contain" engine={logo.engine} size="32px" />
		);
	}
	return <FannedAgentLogos engines={logo.engines} />;
}

/**
 * A team's member logos as bare marks fanned along an arc. They sit with a
 * comfortable gap at rest and spread a little on hover of the mark (CSS only,
 * see `.markHost:hover .fan`) — no card chrome, no React hover state.
 */
function FannedAgentLogos({ engines }: { engines: (string | null)[] }) {
	const shown = engines.slice(0, 5);
	const center = (shown.length - 1) / 2;
	return (
		<div className={styles.fan}>
			{shown.map((engine, i) => {
				const offset = i - center;
				return (
					<span
						className={styles.fanMark}
						data-offset={offset}
						key={`${engine ?? "ryu"}-${offset}`}
					>
						<AgentLogo className="object-contain" engine={engine} size="28px" />
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
	const folder = useWorkspaceStore((state) => state.folder);
	const folderName = showProjectPicker
		? folder?.split(PATH_SEPARATOR).at(-1)
		: null;

	// Strip a trailing "?" so "What are we doing in backstage" reads right
	// once a folder is appended; keep it as plain title when no folder is set.
	const titleText = title.replace(TRAILING_QUESTION, "");

	// Mark, then greeting: one 32px mark above a 24px greeting. The mark's box
	// is reserved (`.markHost`), so a logo that loads late never moves the
	// greeting or the composer under it.
	const mark = interactiveLogo ? (
		// The logo opens the composer's full Agent · Model · Thinking dropdown
		// (the shared ComposerSettingsMenu), not just an agent list — same
		// sections, same behaviour, behind the empty-state mark.
		<ComposerSettingsMenu
			align="center"
			footer={(close) => <PickerSettingsMenu close={close} />}
			renderBody={renderBody}
			sections={sections}
			side="bottom"
			trigger={
				<button
					aria-label="Agent, model and mode settings"
					className={`${styles.markHost} ${styles.logoTrigger}`}
					type="button"
				>
					<EmptyStateMark logo={logo} />
				</button>
			}
		/>
	) : (
		<div aria-hidden="true" className={styles.markHost}>
			<EmptyStateMark logo={logo} />
		</div>
	);

	return (
		<div className="mb-6 flex flex-col items-center gap-4">
			{mark}
			<div className="flex flex-wrap items-baseline justify-center text-balance text-center">
				<h1 className={styles.heading}>
					{folderName ? `${titleText} in ` : title}
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
		</div>
	);
}
