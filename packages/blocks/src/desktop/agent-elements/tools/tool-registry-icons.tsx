// Tool-row glyphs for the tool registry. The registry stores icons as
// components (`ToolMeta.icon`), so each Hugeicons glyph is wrapped once here.
import {
	BookOpen01Icon,
	CancelCircleIcon,
	CheckListIcon,
	ComputerTerminal01Icon,
	FolderSearchIcon,
	GitBranchIcon,
	Globe02Icon,
	Logout01Icon,
	PencilEdit02Icon,
	Search01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { FC } from "react";

type ToolIcon = FC<{ className?: string }>;

function toolIcon(icon: IconSvgElement, displayName: string): ToolIcon {
	const Glyph: ToolIcon = ({ className }) => (
		<HugeiconsIcon className={className} icon={icon} />
	);
	Glyph.displayName = displayName;
	return Glyph;
}

export const BookOpen = toolIcon(BookOpen01Icon, "BookOpen");
export const FolderSearch = toolIcon(FolderSearchIcon, "FolderSearch");
export const GitBranch = toolIcon(GitBranchIcon, "GitBranch");
export const Globe = toolIcon(Globe02Icon, "Globe");
export const ListTodo = toolIcon(CheckListIcon, "ListTodo");
export const LogOut = toolIcon(Logout01Icon, "LogOut");
export const Pencil = toolIcon(PencilEdit02Icon, "Pencil");
export const Search = toolIcon(Search01Icon, "Search");
export const Sparkles = toolIcon(SparklesIcon, "Sparkles");
export const Terminal = toolIcon(ComputerTerminal01Icon, "Terminal");
export const XCircle = toolIcon(CancelCircleIcon, "XCircle");
