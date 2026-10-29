import {
	IconBrandGithub,
	IconBrandGoogle,
	IconBrandReddit,
	IconBrandTwitter,
	IconBrandYoutube,
	IconFileText,
	IconWorld,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

export type SourceType =
	| "web"
	| "github"
	| "google"
	| "reddit"
	| "twitter"
	| "youtube"
	| "file"
	| string;

// Resolve authored names only; prototype member names use the normal fallback.
const SOURCE_ICONS = new Map<string, ComponentType<{ className?: string }>>(
	Object.entries({
		web: IconWorld,
		github: IconBrandGithub,
		google: IconBrandGoogle,
		reddit: IconBrandReddit,
		twitter: IconBrandTwitter,
		youtube: IconBrandYoutube,
		file: IconFileText,
	} satisfies Record<string, ComponentType<{ className?: string }>>)
);

export function SourceIcon({
	source,
	className,
}: {
	source: SourceType;
	className?: string;
}) {
	const Icon = SOURCE_ICONS.get(source) ?? IconWorld;
	return <Icon className={className} />;
}
