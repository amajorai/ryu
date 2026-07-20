"use client";

import { useEffect, useState } from "react";
import {
	GITHUB_RELEASES_REPO,
	GITHUB_REPO,
	LATEST_RELEASE_API,
} from "./download.tsx";

const siteVersion = process.env.NEXT_PUBLIC_APP_VERSION;
const gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT;

function shortSha(sha: string) {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

const linkClass =
	"transition-colors hover:text-foreground underline-offset-4 hover:underline";

export default function FooterBuildInfo() {
	const [latestRelease, setLatestRelease] = useState<string | null>(null);

	useEffect(() => {
		fetch(LATEST_RELEASE_API)
			.then((res) => (res.ok ? res.json() : null))
			.then((data: { tag_name?: string } | null) => {
				if (data?.tag_name) {
					setLatestRelease(data.tag_name);
				}
			})
			.catch(() => {
				// Best-effort; deploy version + commit still render without it.
			});
	}, []);

	const commit = gitCommit ? shortSha(gitCommit) : null;
	const commitUrl = gitCommit
		? `${GITHUB_REPO}/commit/${gitCommit}`
		: GITHUB_REPO;
	const releaseUrl = latestRelease
		? `https://github.com/${GITHUB_RELEASES_REPO}/releases/tag/${latestRelease}`
		: `${GITHUB_REPO}/releases`;

	return (
		<p className="text-muted-foreground text-xs">
			<a
				className={linkClass}
				href={GITHUB_REPO}
				rel="noopener noreferrer"
				target="_blank"
			>
				GitHub
			</a>
			{latestRelease ? (
				<>
					{" · "}
					<a
						className={linkClass}
						href={releaseUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						Release {latestRelease}
					</a>
				</>
			) : null}
			{siteVersion ? (
				<>
					{" · "}
					<span>Site {siteVersion}</span>
				</>
			) : null}
			{commit ? (
				<>
					{" · "}
					<a
						className={linkClass}
						href={commitUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						{commit}
					</a>
				</>
			) : null}
		</p>
	);
}
