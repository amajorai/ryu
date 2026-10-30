import { Alert02Icon } from "@hugeicons/core-free-icons";
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
import {
	Component,
	type ErrorInfo,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { reportError } from "@/src/lib/crash.ts";

/** The error panel's title; a component so the class boundary can translate it. */
function InterfaceErrorTitle({ label }: { label: string }) {
	const tl = useLiteralMessages();
	return <>{tl("{label} could not be shown", { label })}</>;
}

interface InterfaceErrorBoundaryProps {
	children: ReactNode;
	label: string;
	/** Leave for the default chat (the escape every failure state offers). */
	onBackToChat: () => void;
	/** The renderer threw again after its retry: switch it off. */
	onGiveUp: () => void;
}

interface InterfaceErrorBoundaryState {
	failed: boolean;
}

/**
 * A renderer that throws is retried once (remounted); if it throws again the
 * host switches it off and returns to the default chat (`onGiveUp`). Until
 * then, and if that ever fails, the panel offers Back to chat.
 */
export class InterfaceErrorBoundary extends Component<
	InterfaceErrorBoundaryProps,
	InterfaceErrorBoundaryState
> {
	state: InterfaceErrorBoundaryState = { failed: false };
	private failures = 0;

	static getDerivedStateFromError(): InterfaceErrorBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		reportError(error, {
			extra: { componentStack: info.componentStack ?? "" },
			tags: { surface: "interface" },
		});
		this.failures += 1;
		if (this.failures === 1) {
			// One retry: remount the renderer.
			this.setState({ failed: false });
			return;
		}
		this.props.onGiveUp();
	}

	render() {
		if (!this.state.failed) {
			return this.props.children;
		}
		return (
			<Empty className="size-full" data-testid="interface-error">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Alert02Icon} />
					</EmptyMedia>
					<EmptyTitle>
						<InterfaceErrorTitle label={this.props.label} />
					</EmptyTitle>
					<EmptyDescription>
						Your agents and threads are unaffected.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={this.props.onBackToChat} type="button">
						Back to chat
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
}

/** Shown in place of a renderer when the conversation list could not be read,
 *  so a failed load never reads as an empty workspace. */
export function SnapshotUnavailable({
	label,
	onRetry,
}: {
	label: string;
	onRetry: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Empty className="size-full" data-testid="interface-unavailable">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Alert02Icon} />
				</EmptyMedia>
				<EmptyTitle>Couldn't load conversations</EmptyTitle>
				<EmptyDescription>
					{tl(
						"{label} has nothing to show until your conversations load. Your agents and threads are unaffected.",
						{ label }
					)}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onRetry} type="button">
					Retry
				</Button>
			</EmptyContent>
		</Empty>
	);
}

/** How long a renderer may take to mount before Back to chat is offered. */
export const SLOW_MOUNT_MS = 10_000;

/**
 * The placeholder while a renderer loads (its code, or a Marketplace
 * interface's plugin list). Past {@link SLOW_MOUNT_MS} it offers Back to chat,
 * so a renderer that never mounts cannot hold the window.
 */
export function RendererFallback({
	label,
	onBackToChat,
}: {
	label: string;
	onBackToChat: () => void;
}) {
	const tl = useLiteralMessages();
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setSlow(true), SLOW_MOUNT_MS);
		return () => window.clearTimeout(timer);
	}, []);
	if (!slow) {
		return (
			<div aria-busy="true" className="size-full bg-background" role="status">
				<span className="sr-only">{tl("Loading {label}", { label })}</span>
			</div>
		);
	}
	return (
		<Empty className="size-full" data-testid="interface-slow">
			<EmptyHeader>
				<EmptyTitle>
					{tl("{label} is taking a while to open", { label })}
				</EmptyTitle>
				<EmptyDescription>
					It may still appear. You can go back to the chat in the meantime.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={onBackToChat} type="button">
					Back to chat
				</Button>
			</EmptyContent>
		</Empty>
	);
}
