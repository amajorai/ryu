import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";

/**
 * The panel's centered state — startup, failure, and "nothing to show" all render
 * through this one shape so they cannot drift into three different-looking screens.
 * `busy` swaps the icon for a spinner; `onRetry` adds the action, disabled while
 * `retryDisabledFor` seconds remain (armed on press and counted down in place, so
 * the button says why it is dead).
 */
export function PanelPlaceholder({
	busy,
	description,
	onRetry,
	retryDisabledFor = 0,
	title,
}: {
	busy?: boolean;
	description: string;
	onRetry?: () => void;
	retryDisabledFor?: number;
	title: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex h-full items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						{busy ? <Spinner /> : <HugeiconsIcon icon={PlugSocketIcon} />}
					</EmptyMedia>
					<EmptyTitle>{title}</EmptyTitle>
					<EmptyDescription>{description}</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button
							disabled={retryDisabledFor > 0}
							onClick={onRetry}
							size="sm"
							variant="ghost"
						>
							{retryDisabledFor > 0
								? tl("Retry in {retryDisabledFor}s", { retryDisabledFor })
								: "Retry"}
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		</div>
	);
}
