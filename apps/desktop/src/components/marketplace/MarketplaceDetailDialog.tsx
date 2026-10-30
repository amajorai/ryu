// apps/desktop/src/components/marketplace/MarketplaceDetailDialog.tsx
//
// App-Store / ChatGPT-plugin-style listing preview. Renders ONE canonical detail
// payload (lib/api/marketplace.ts `MarketplaceDetail`) produced by all three
// detail sources (built-in manifest, git MarketplaceSource, Ryu Mongo). The
// default view is intentionally small: identity, a manifest-driven sample-prompt
// banner, and the short description. Screenshots, setup, bundled skills, trust
// metadata, links, and reviews stay behind "More details" so the preview answers
// what the item does before asking the user to inspect its implementation.
//
// Every section renders ONLY when its data is present, so an older listing
// missing the richer fields still renders gracefully. The write form is gated to
// signed-in users; paid items are verified-purchasers-only server-side (surfaced
// as a "purchase" error), and a user may edit or delete their own review.

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useEffect, useState } from "react";
import type { MarketplaceKind } from "@/src/lib/api/marketplace.ts";
import { DetailBody } from "./detail/DetailBody.tsx";

export default function MarketplaceDetailDialog({
	open,
	onClose,
	kind,
	id,
	initialName,
	initialIconUrl,
	onInstallBundle,
	bundleInstalling = false,
}: {
	open: boolean;
	onClose: () => void;
	kind: MarketplaceKind;
	id: string;
	/** Optional seed so the header shows a name before detail loads. */
	initialName?: string;
	initialIconUrl?: string | null;
	onInstallBundle?: () => void;
	bundleInstalling?: boolean;
}) {
	const [screenshotOpen, setScreenshotOpen] = useState(false);
	useEffect(() => setScreenshotOpen(false), [id, kind, open]);
	return (
		<Dialog
			onOpenChange={(next, eventDetails) => {
				if (next) {
					return;
				}
				if (
					screenshotOpen ||
					(eventDetails.reason === "escape-key" &&
						eventDetails.event.defaultPrevented)
				) {
					eventDetails.cancel();
					return;
				}
				onClose();
			}}
			open={open}
		>
			{/* The paid preview is intentionally a focused 720px card: identity,
			    sample prompts, and a short description first. Advanced install and trust
			    metadata stays behind the in-card disclosure below. */}
			<DialogContent appearance="marketplace-detail">
				<DialogHeader className="sr-only">
					<DialogTitle>{initialName ?? "Listing"}</DialogTitle>
				</DialogHeader>
				<div className="scroll-fade max-h-[88vh] overflow-y-auto overflow-x-hidden">
					{open ? (
						<DetailBody
							bundleInstalling={bundleInstalling}
							id={id}
							initialIconUrl={initialIconUrl}
							initialName={initialName}
							kind={kind}
							onInstallBundle={onInstallBundle}
							onScreenshotOpenChange={setScreenshotOpen}
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
