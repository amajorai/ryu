import { cn } from "@ryu/ui/lib/utils";

export type SvglSpec = string | { light: string; dark: string };

// Bundled brand marks (originally sourced from svgl.app) served from each app's
// public dir at `/logos/<slug>.svg` — no remote fetch, works offline and never
// 404s on a renamed upstream slug.
const svglUrl = (slug: string) => `/logos/${slug}.svg`;

/** Bundled brand mark (slug → local `/logos/<slug>.svg`). */
export function SvglIcon({
	spec,
	alt = "",
	className,
	size = 16,
}: {
	spec: SvglSpec;
	alt?: string;
	className?: string;
	size?: number;
}) {
	const _style = { width: size, height: size };

	if (typeof spec === "string") {
		return (
			<img
				alt={alt}
				aria-hidden={alt ? undefined : true}
				className={cn("shrink-0 object-contain", className)}
				draggable={false}
				height={size}
				src={svglUrl(spec)}
				width={size}
			/>
		);
	}

	return (
		<>
			<img
				alt={alt}
				aria-hidden={alt ? undefined : true}
				className={cn("block shrink-0 object-contain dark:hidden", className)}
				draggable={false}
				height={size}
				src={svglUrl(spec.light)}
				width={size}
			/>
			<img
				alt={alt}
				aria-hidden={alt ? undefined : true}
				className={cn("hidden shrink-0 object-contain dark:block", className)}
				draggable={false}
				height={size}
				src={svglUrl(spec.dark)}
				width={size}
			/>
		</>
	);
}

export const OS_SVGL = {
	macos: { light: "apple", dark: "apple_dark" },
	windows: "windows",
	linux: "linux",
} as const satisfies Record<string, SvglSpec>;

export const BROWSER_SVGL = {
	chrome: "chrome",
	firefox: "firefox",
	edge: "edge",
} as const satisfies Record<string, SvglSpec>;

export const MOBILE_SVGL = {
	ios: { light: "apple", dark: "apple_dark" },
	android: "android-icon",
} as const satisfies Record<string, SvglSpec>;

export const GITHUB_SVGL = {
	light: "github_light",
	dark: "github_dark",
} as const satisfies SvglSpec;
