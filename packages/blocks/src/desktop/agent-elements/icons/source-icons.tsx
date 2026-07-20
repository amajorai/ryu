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

const SOURCE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
	web: IconWorld,
	github: IconBrandGithub,
	google: IconBrandGoogle,
	reddit: IconBrandReddit,
	twitter: IconBrandTwitter,
	youtube: IconBrandYoutube,
	file: IconFileText,
};

export function SourceIcon({
	source,
	className,
}: {
	source: SourceType;
	className?: string;
}) {
	const Icon = SOURCE_ICONS[source] ?? IconWorld;
	return <Icon className={className} />;
}
