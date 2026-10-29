"use client";

import {
	Component,
	memo,
	type ReactNode,
	Suspense,
	use,
	useDeferredValue,
	useState,
} from "react";
import type { AssistantSessionProps } from "./assistant-session.tsx";

type SessionModule = typeof import("./assistant-session.tsx");
type LoadStatus = "fulfilled" | "pending" | "rejected";
type TrackedLoad = Promise<SessionModule> & {
	reason?: unknown;
	status?: LoadStatus;
	value?: SessionModule;
};

let sessionLoad: TrackedLoad | null = null;

/**
 * Starts (or reuses) the Ask Ryu session chunk: the chat surface, runtimes and
 * settings. The status fields follow React's thenable protocol, so `use` reads
 * a settled load synchronously (warm server, reopen, tests) instead of
 * suspending again. A failed load stays cached until a retry clears it, so a
 * render cannot loop on a chunk that keeps failing.
 */
export function loadAssistantSession(): Promise<SessionModule> {
	if (sessionLoad) {
		return sessionLoad;
	}
	const load: TrackedLoad = import("./assistant-session.tsx");
	load.status = "pending";
	load.then(
		(value) => {
			load.status = "fulfilled";
			load.value = value;
		},
		(reason: unknown) => {
			load.status = "rejected";
			load.reason = reason;
		}
	);
	sessionLoad = load;
	return load;
}

function retryAssistantSessionLoad(): void {
	if (sessionLoad?.status === "rejected") {
		sessionLoad = null;
	}
	loadAssistantSession();
}

/** Warms the chunk on launcher intent; a failed earlier load is retried. */
export function preloadAssistantSession(): void {
	retryAssistantSessionLoad();
}

/** Diagnostics and test seam. */
export function assistantSessionLoadStatus(): "idle" | LoadStatus {
	return sessionLoad?.status ?? "idle";
}

function SessionBody(props: AssistantSessionProps) {
	const { AssistantSession } = use(loadAssistantSession());
	return <AssistantSession {...props} />;
}

function SessionLoading() {
	return (
		<div
			aria-busy="true"
			className="flex h-full items-center justify-center text-muted-foreground text-sm"
			role="status"
		>
			Loading Ask Ryu…
		</div>
	);
}

function SessionLoadError({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
			role="alert"
		>
			<p>Ask Ryu could not load.</p>
			<button
				className="rounded-full px-3 py-1.5 font-medium underline-offset-4 hover:underline focus-visible:outline-2"
				onClick={onRetry}
				type="button"
			>
				Try again
			</button>
		</div>
	);
}

interface BoundaryProps {
	children: ReactNode;
	fallback: ReactNode;
}
interface BoundaryState {
	failed: boolean;
}

// React error boundaries have no functional equivalent, so a class is required here.
// biome-ignore lint/style/useReactFunctionComponents: error boundaries must be class components
class SessionLoadBoundary extends Component<BoundaryProps, BoundaryState> {
	constructor(props: BoundaryProps) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError(): BoundaryState {
		return { failed: true };
	}

	render() {
		if (this.state.failed) {
			return this.props.fallback;
		}
		return this.props.children;
	}
}

/** The boundary pair; memoized so an urgent parent render cannot reach it. */
const SessionLoader = memo(function SessionLoader(
	props: AssistantSessionProps
) {
	const [attempt, setAttempt] = useState(0);
	const retry = () => {
		retryAssistantSessionLoad();
		setAttempt((current) => current + 1);
	};
	return (
		<SessionLoadBoundary
			fallback={<SessionLoadError onRetry={retry} />}
			key={attempt}
		>
			<Suspense fallback={<SessionLoading />}>
				<SessionBody {...props} />
			</Suspense>
		</SessionLoadBoundary>
	);
});

/**
 * The Ask Ryu session behind a Suspense boundary. The launcher shell imports
 * only this loader, so the chat chunk stays off the page until it is opened.
 * A load or render failure stays inside the widget instead of reaching the
 * host route's error page.
 *
 * Props reach the boundary as a deferred value. A server-rendered panel
 * (`inline`, `openOnMount`) stays dehydrated until its chunk arrives, and an
 * urgent update to a dehydrated boundary would discard the server HTML for
 * the loading fallback; a deferred (transition) update waits instead.
 */
export function DeferredAssistantSession(props: AssistantSessionProps) {
	const deferredProps = useDeferredValue(props);
	return <SessionLoader {...deferredProps} />;
}
