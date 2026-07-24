// packages/marketplace/src/catalog/chrome/community-trust-notice.tsx
//
// The one "not reviewed by Ryu" disclosure, shared by desktop and web. Community
// listings are discovered automatically from public GitHub topics — anyone can tag
// a repo `ryu-app` / `ryu-plugin` and appear here — so every surface that shows one
// must also show this.
//
// It reads `openExternal` off the catalog host itself, so no caller threads a
// handler: desktop opens the Tauri shell, web navigates, and neither needs
// surface-specific code.

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCatalogHost } from "../host.tsx";

/** The GitHub topics Core's `github-topic` catalog source discovers. Kept in sync
 *  with `GITHUB_TOPIC_APP` / `GITHUB_TOPIC_PLUGIN` in
 *  `apps/core/src/catalog_source/github_topic.rs`. */
export const COMMUNITY_TOPICS = {
	app: "ryu-app",
	plugin: "ryu-plugin",
} as const;

/** Hardcoded on purpose: `NEXT_PUBLIC_DOCS_URL` is inlined by Next at build time
 *  and does not exist in the Vite/Tauri desktop build, where it would silently
 *  resolve to a localhost link. */
const COMMUNITY_TRUST_DOC_URL =
	"https://docs.ryuhq.com/docs/security/trust-model";

const BOTH_TOPICS = `${COMMUNITY_TOPICS.app} / ${COMMUNITY_TOPICS.plugin}`;

/**
 * "Not reviewed by Ryu" notice for community (GitHub topic-discovered) listings.
 *
 * `tone="banner"` sits above the card grid; `tone="inline"` sits in the detail
 * panel directly above the install/affordance block, which is the load-bearing
 * placement — it is unavoidable in the reading path before any install action, in
 * both the side-pane and the dialog preview.
 */
export default function CommunityTrustNotice({
	topic,
	tone = "banner",
	className,
}: {
	className?: string;
	/** The specific topic this listing came from; omitted = both. */
	topic?: string | null;
	tone?: "banner" | "inline";
}) {
	const host = useCatalogHost();
	const topicLabel = topic?.trim() ? topic.trim() : BOTH_TOPICS;

	return (
		<Alert
			className={cn(
				"border-amber-500/30 bg-amber-500/5 text-foreground",
				tone === "inline" && "px-3 py-2.5",
				className
			)}
			data-testid="community-trust-notice"
		>
			<HugeiconsIcon className="text-amber-600" icon={Alert02Icon} />
			<AlertTitle>Not reviewed by Ryu</AlertTitle>
			<AlertDescription>
				Listings are discovered automatically from the GitHub topic{" "}
				<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
					{topicLabel}
				</code>
				. They are published by third parties and are not reviewed by Ryu, so
				install at your own discretion.{" "}
				<button
					className="underline underline-offset-3 hover:text-foreground"
					onClick={() => host.openExternal(COMMUNITY_TRUST_DOC_URL)}
					type="button"
				>
					Read the trust guidance
				</button>
			</AlertDescription>
		</Alert>
	);
}
