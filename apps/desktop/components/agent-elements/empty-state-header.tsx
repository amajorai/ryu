"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useState } from "react";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { ProjectPickerContent } from "@/src/components/chat/ProjectPicker.tsx";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

const TRAILING_QUESTION = /\?\s*$/;
const PATH_SEPARATOR = /[\\/]/;

/** What the empty-state logo represents: a single engine, a custom uploaded
 *  agent image, or a fanned stack of engines (the Ryu flagship "home" identity,
 *  or a team's members). */
export type EmptyStateLogo =
	| { kind: "single"; engine: string | null }
	| { kind: "image"; url: string }
	| { kind: "stack"; engines: (string | null)[] };

/** Render the empty-state mark for the active target. */
function EmptyStateMark({
	logo,
	hovered,
}: {
	logo: EmptyStateLogo;
	hovered: boolean;
}) {
	if (logo.kind === "image") {
		return (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; avatar is an inline data URL
			// biome-ignore lint/correctness/useImageSize: sized via the `size-14` class
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
		<div className="relative h-16 w-80">
			{shown.map((engine, i) => {
				const offset = i - center;
				// Spread wider (and tilt a touch more) on hover; never pile up.
				const spread = hovered ? 60 : 46;
				const rotate = offset * (hovered ? 12 : 6);
				const x = offset * spread;
				const y = -Math.abs(offset) * (hovered ? 6 : 3);
				return (
					<span
						className="absolute top-1/2 left-1/2 transition-transform duration-200 ease-in-out"
						key={`${engine ?? "ryu"}-${offset}`}
						style={{
							transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${rotate}deg)`,
							zIndex: 10 - Math.round(Math.abs(offset)),
						}}
					>
						<AgentLogo className="object-contain" engine={engine} size="44px" />
					</span>
				);
			})}
		</div>
	);
}

export interface EmptyStateHeaderProps {
	logo: EmptyStateLogo;
	/**
	 * The composer's composed Agent · Model · Approval/Thinking sections (from
	 * `useComposerAgentControls().sections`). The logo opens the SAME dropdown as
	 * the composer's settings menu — not just an agent list — so a mode/thinking
	 * level can be picked straight from the empty state.
	 */
	/**
	 * The universal picker body (from `useComposerAgentControls().renderBody`). When
	 * provided, the logo opens the SAME grouped `Ryu Portal · Providers · External
	 * Agents` dropdown as the composer. Omit to fall back to the sibling-section list.
	 */
	renderBody?: (close: () => void) => ReactNode;
	sections: ComposerSettingsSection[];
	title?: string;
}

/**
 * The chat empty state: an editable-feeling heading "What are we doing in
 * <folder>", with a clickable agent logo below that opens the same
 * Agent · Model · Thinking dropdown as the composer. The folder name is a
 * hover-revealed trigger that opens the project folder selector.
 */
export function EmptyStateHeader({
	title = "What are we doing?",
	logo,
	sections,
	renderBody,
}: EmptyStateHeaderProps) {
	const [folderOpen, setFolderOpen] = useState(false);
	const [hovered, setHovered] = useState(false);
	const { folder } = useWorkspaceStore();
	const folderName = folder ? folder.split(PATH_SEPARATOR).at(-1) : null;

	// Strip a trailing "?" so "What are we doing in backstage" reads right
	// once a folder is appended; keep it as plain title when no folder is set.
	const titleText = title.replace(TRAILING_QUESTION, "");

	return (
		<div className="flex flex-col items-center">
			<div className="mb-7 flex flex-wrap items-baseline justify-center text-center">
				<h1 className="font-heading text-[28px] text-foreground tracking-tight">
					{folderName ? `${titleText} in ` : title}
				</h1>
				{folderName && (
					<>
						<Popover onOpenChange={setFolderOpen} open={folderOpen}>
							<PopoverTrigger
								render={
									<Button
										aria-label="Select project folder"
										className={cn(
											"h-auto gap-0 rounded-md px-0 py-0 font-heading font-normal text-[28px] text-foreground tracking-tight hover:bg-muted",
											folderOpen && "bg-muted"
										)}
										size="sm"
										title={folder ?? undefined}
										type="button"
										variant="ghost"
									/>
								}
							>
								<span className="max-w-48 truncate">{folderName}</span>
							</PopoverTrigger>
							<PopoverContent
								align="center"
								className="w-64 rounded-2xl p-1"
								side="bottom"
								sideOffset={6}
							>
								<ProjectPickerContent onClose={() => setFolderOpen(false)} />
							</PopoverContent>
						</Popover>
						<h1 className="font-heading text-[28px] text-foreground tracking-tight">
							?
						</h1>
					</>
				)}
			</div>

			{/* The logo opens the composer's full Agent · Model · Thinking dropdown
			    (the shared ComposerSettingsMenu), not just an agent list — same
			    sections, same behaviour, behind the big empty-state mark. */}
			<ComposerSettingsMenu
				align="center"
				renderBody={renderBody}
				sections={sections}
				side="bottom"
				trigger={
					<button
						aria-label="Agent, model and mode settings"
						className="relative top-5 z-0 flex items-center justify-center rounded-2xl p-1 transition-transform hover:scale-[1.03] active:scale-[0.97]"
						onMouseEnter={() => setHovered(true)}
						onMouseLeave={() => setHovered(false)}
						type="button"
					>
						<EmptyStateMark hovered={hovered} logo={logo} />
					</button>
				}
			/>
		</div>
	);
}
