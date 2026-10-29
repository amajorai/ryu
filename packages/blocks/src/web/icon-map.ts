import type { LucideIcon } from "lucide-react";
import {
	Blocks,
	Bot,
	Box,
	Boxes,
	Bug,
	Cable,
	Chrome,
	Cloud,
	Cpu,
	Eye,
	Gem,
	GitBranch,
	Globe,
	HeartHandshake,
	Key,
	Layers,
	Mic,
	Monitor,
	Plug,
	Puzzle,
	Radio,
	RefreshCw,
	Shield,
	Smartphone,
	Sparkles,
	Store,
	Terminal,
	Users,
	Zap,
} from "lucide-react";

// Resolve authored names only; prototype member names use the normal fallback.
const iconMap = new Map<string, LucideIcon>(
	Object.entries({
		Blocks,
		Bot,
		Box,
		Boxes,
		Bug,
		Cable,
		Chrome,
		Cloud,
		Cpu,
		Eye,
		Gem,
		GitBranch,
		Globe,
		HeartHandshake,
		Key,
		Layers,
		Mic,
		Monitor,
		Plug,
		Puzzle,
		Radio,
		RefreshCw,
		Shield,
		Smartphone,
		Sparkles,
		Store,
		Terminal,
		Users,
		Zap,
	} satisfies Record<string, LucideIcon>)
);

export function resolveIcon(name: string | undefined): LucideIcon | undefined {
	if (!name) {
		return undefined;
	}
	return iconMap.get(name);
}
