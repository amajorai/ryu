import {
	File01Icon,
	GithubIcon,
	Globe02Icon,
	GoogleIcon,
	NewTwitterIcon,
	RedditIcon,
	YoutubeIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentType } from "react";
import { hugeiconComponent } from "./hugeicon-component.tsx";

const IconBrandGithub = hugeiconComponent(GithubIcon);
const IconBrandGoogle = hugeiconComponent(GoogleIcon);
const IconBrandReddit = hugeiconComponent(RedditIcon);
const IconBrandTwitter = hugeiconComponent(NewTwitterIcon);
const IconBrandYoutube = hugeiconComponent(YoutubeIcon);
const IconFileText = hugeiconComponent(File01Icon);
const IconWorld = hugeiconComponent(Globe02Icon);

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
