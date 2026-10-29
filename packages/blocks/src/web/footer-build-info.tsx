"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
// Imported from the JSX-free asset module, not `./download.tsx`: that page
// module re-exports these constants but would pull the whole download page
// (hero, sections, motion) into every page's footer bundle.
import {
	GITHUB_RELEASES_REPO,
	GITHUB_REPO,
	LATEST_RELEASE_API,
} from "./download-assets.ts";
import { GitHubStars } from "./github-stars.tsx";
import { GITHUB_SVGL, SvglIcon } from "./svgl-icon.tsx";
import { whenBrowserIdle } from "./when-browser-idle.ts";

const siteVersion = process.env.NEXT_PUBLIC_APP_VERSION;
const gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT;

function shortSha(sha: string) {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

const linkClass =
	"transition-colors hover:text-foreground underline-offset-4 hover:underline";

/**
 * The desktop release ships on the same version train as the site, so the site's
 * build version is the static fallback. The line then reads the same on every route,
 * whether or not the GitHub API answers.
 */
const RELEASE_FALLBACK = siteVersion
	? `v${siteVersion.replace(/^v/, "")}`
	: null;

export default function FooterBuildInfo({
	githubStargazersCount,
}: {
	githubStargazersCount?: number | null;
}) {
	const tl = useLiteralMessages();
	const [latestRelease, setLatestRelease] = useState<string | null>(
		RELEASE_FALLBACK
	);

	// The footer is below the fold and already shows the build version, so the
	// release lookup waits for an idle moment instead of competing with the
	// page's first load.
	useEffect(() => {
		let cancelled = false;
		const cancelIdle = whenBrowserIdle(() => {
			fetch(LATEST_RELEASE_API)
				.then((res) => (res.ok ? res.json() : null))
				.then((data: { tag_name?: string } | null) => {
					if (!cancelled && data?.tag_name) {
						setLatestRelease(data.tag_name);
					}
				})
				.catch(() => {
					// Best-effort; deploy version + commit still render without it.
				});
		});
		return () => {
			cancelled = true;
			cancelIdle();
		};
	}, []);

	const commit = gitCommit ? shortSha(gitCommit) : null;
	const commitUrl = gitCommit
		? `${GITHUB_REPO}/commit/${gitCommit}`
		: GITHUB_REPO;
	const releaseUrl = latestRelease
		? `https://github.com/${GITHUB_RELEASES_REPO}/releases/tag/${latestRelease}`
		: `${GITHUB_REPO}/releases`;

	const parts: { className?: string; key: string; node: ReactNode }[] = [];
	if (latestRelease) {
		parts.push({
			key: "release",
			node: (
				<a
					className={linkClass}
					href={releaseUrl}
					rel="noopener noreferrer"
					target="_blank"
				>
					{tl("Release {latestRelease}", { latestRelease })}
				</a>
			),
		});
	}
	if (siteVersion) {
		parts.push({
			key: "site",
			node: <span>{tl("Site {siteVersion}", { siteVersion })}</span>,
		});
	}
	if (commit) {
		parts.push({
			// The commit hash is build detail; below md it only crowds the line.
			className: "hidden md:inline",
			key: "commit",
			node: (
				<a
					className={linkClass}
					href={commitUrl}
					rel="noopener noreferrer"
					target="_blank"
				>
					{commit}
				</a>
			),
		});
	}

	return (
		<p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
			<a
				aria-label="Ryu on GitHub"
				className="text-muted-foreground transition-colors hover:text-foreground"
				href={GITHUB_REPO}
				rel="noopener noreferrer"
				target="_blank"
			>
				{githubStargazersCount != null && githubStargazersCount > 0 ? (
					<GitHubStars stargazersCount={githubStargazersCount} />
				) : (
					<SvglIcon size={16} spec={GITHUB_SVGL} />
				)}
			</a>
			{parts.map((part, index) => (
				<Fragment key={part.key}>
					{index > 0 ? (
						<span aria-hidden="true" className={part.className}>
							·
						</span>
					) : null}
					{part.className ? (
						<span className={part.className}>{part.node}</span>
					) : (
						part.node
					)}
				</Fragment>
			))}
		</p>
	);
}
