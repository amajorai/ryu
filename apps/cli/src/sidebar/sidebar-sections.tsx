// The sidebar's collapsible sections: the per-kind sections (Agents, Chats,
// ...) and the Projects group, each under a header that folds in place.

// biome-ignore-all lint/a11y/useKeyWithClickEvents: keyboard navigation runs
// through the sidebar's focus mode (one useKeyboard over the flat row list), not
// per sidebar element.

import { useContext } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSelectionSafeActivate } from "../ui/clipboard.ts";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import type { ProjectGroup, SidebarItem } from "./data.ts";
import {
	displayWidth,
	PROJECT_CHAT_LIMIT,
	SECTION_ITEM_LIMIT,
	type SectionKey,
	type SectionSpec,
	SIDEBAR_CONTENT_WIDTH,
	truncateLabel,
} from "./rows.ts";
import { projectsHeading, sectionHeading } from "./section-heading.ts";
import { RowBox, SidebarFocusContext } from "./sidebar-row.tsx";

function SectionHeader({
	collapsed,
	count,
	onToggle,
	section,
	title,
}: {
	collapsed: boolean;
	count: number;
	onToggle: () => void;
	section: SectionKey;
	title: string;
}) {
	const theme = useTheme();
	return (
		<RowBox header onSelect={onToggle} rowKey={`section:${section}`}>
			{(tone) => (
				<>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						{collapsed ? "▸" : "▾"}
					</text>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						{title}
					</text>
					<text fg={tone(theme.colors.mutedForeground)} selectable={false}>
						{count}
					</text>
				</>
			)}
		</RowBox>
	);
}

export function SidebarSection({
	collapsed,
	items,
	onToggle,
	section,
}: {
	collapsed: boolean;
	items: SidebarItem[];
	onToggle: (section: SectionKey) => void;
	section: SectionSpec;
}) {
	const activate = useSelectionSafeActivate();
	const theme = useTheme();
	const { openTab } = useWorkspace();
	const { release } = useContext(SidebarFocusContext);
	return (
		<box flexDirection="column" paddingTop={1}>
			<box flexDirection="row" gap={1} justifyContent="space-between">
				<SectionHeader
					collapsed={collapsed}
					count={items.length}
					onToggle={() => onToggle(section.key)}
					section={section.key}
					title={sectionHeading(section.title)}
				/>
				<text
					fg={theme.colors.mutedForeground}
					{...activate(() => {
						openTab(section.createPath);
						release();
					})}
					selectable={false}
				>
					+
				</text>
			</box>
			{collapsed ? null : <SectionItems items={items} section={section.key} />}
		</box>
	);
}

function SectionItems({
	items,
	section,
}: {
	items: SidebarItem[];
	section: SectionKey;
}) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	if (items.length === 0) {
		return (
			<text fg={theme.colors.mutedForeground} selectable={false}>
				empty
			</text>
		);
	}
	return (
		<box flexDirection="column">
			{items.slice(0, SECTION_ITEM_LIMIT).map((item) => {
				// The badge and its gap come out of the label's budget.
				const badgeColumns = item.badge ? displayWidth(item.badge) + 1 : 0;
				return (
					<RowBox
						key={item.id}
						onSelect={() => openTab(item.path)}
						rowKey={`item:${section}:${item.id}`}
					>
						{(tone) => (
							<>
								<text fg={tone(theme.colors.foreground)} selectable={false}>
									{truncateLabel(
										item.label,
										SIDEBAR_CONTENT_WIDTH - badgeColumns
									)}
								</text>
								{item.badge ? (
									<text
										fg={tone(theme.colors.mutedForeground)}
										selectable={false}
									>
										{item.badge}
									</text>
								) : null}
							</>
						)}
					</RowBox>
				);
			})}
		</box>
	);
}

export function ProjectsSection({
	collapsed,
	onToggle,
	projects,
}: {
	collapsed: boolean;
	onToggle: (section: SectionKey) => void;
	projects: ProjectGroup[];
}) {
	const theme = useTheme();
	const { openTab } = useWorkspace();
	return (
		<box flexDirection="column" paddingTop={1}>
			<SectionHeader
				collapsed={collapsed}
				count={projects.length}
				onToggle={() => onToggle("projects")}
				section="projects"
				title={projectsHeading()}
			/>
			{collapsed ? null : (
				<box flexDirection="column">
					{projects.length === 0 ? (
						<text fg={theme.colors.mutedForeground} selectable={false}>
							empty
						</text>
					) : (
						projects.map((project) => (
							<box flexDirection="column" key={project.id} paddingLeft={1}>
								<text fg={theme.colors.accent} selectable={false}>
									{truncateLabel(project.name, SIDEBAR_CONTENT_WIDTH - 1)}
								</text>
								{project.chats.slice(0, PROJECT_CHAT_LIMIT).map((chat) => (
									<RowBox
										key={chat.id}
										onSelect={() => openTab(chat.path)}
										paddingLeft={1}
										rowKey={`item:projects:${project.id}:${chat.id}`}
									>
										{(tone) => (
											<text
												fg={tone(theme.colors.foreground)}
												selectable={false}
											>
												{truncateLabel(chat.label, SIDEBAR_CONTENT_WIDTH - 2)}
											</text>
										)}
									</RowBox>
								))}
							</box>
						))
					)}
				</box>
			)}
		</box>
	);
}
