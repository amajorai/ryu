// packages/marketplace/src/catalog/chrome/deprecation-notice.tsx
//
// The "this listing is deprecated" disclosure on a listing's detail page, shared
// by desktop and web. Rendered in the detail shell's `notice` slot so it sits in
// the reading path BEFORE the install action, where it cannot be scrolled past.

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { DEPRECATED_LABEL } from "../deprecation.ts";

/**
 * Deprecation notice for a listing whose manifest sets `deprecated`. The
 * listing still installs and runs; this explains why it should not be picked
 * for new work and, when the publisher named one, what supersedes it.
 */
export default function DeprecationNotice({
	className,
	message,
	name,
	replacement,
}: {
	className?: string;
	/** The publisher's explanation, already normalised by the producer. */
	message?: string | null;
	/** The listing's display name, for the fallback sentence. */
	name: string;
	/** Id of the superseding listing, rendered verbatim. */
	replacement?: string | null;
}) {
	const tl = useLiteralMessages();
	return (
		<Alert
			className={className}
			data-testid="deprecation-notice"
			variant="warning"
		>
			<HugeiconsIcon icon={Alert02Icon} />
			<AlertTitle>{DEPRECATED_LABEL}</AlertTitle>
			<AlertDescription>
				{message ??
					tl(
						"The publisher has deprecated {name}. It keeps working where it is installed, but avoid it for new setups.",
						{ name }
					)}
				{replacement ? (
					<>
						{" "}
						Use{" "}
						<code className="rounded-lg bg-muted px-1 py-0.5 font-mono text-xs">
							{replacement}
						</code>{" "}
						instead.
					</>
				) : null}
			</AlertDescription>
		</Alert>
	);
}
