// apps/desktop/src/components/CrashBoundary.tsx
//
// Renderer error boundary for the crash reporting tier (#544, P3). Wraps the app so
// an unhandled render error is (a) caught and shown a recoverable fallback instead
// of a white screen, and (b) reported to Sentry — but ONLY when the user consented
// to crash reports AND a DSN is configured (the gate lives in reportError()).
//
// This is the renderer half of the Rust panic tier in apps/core/src/crash.rs. It
// never reports prompt/agent content: only the error itself, already PII-scrubbed
// by crash.ts's beforeSend.

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { getConsoleBufferText } from "@/src/lib/console-buffer.ts";
import { reportError } from "@/src/lib/crash.ts";
import { getCrashRoute } from "@/src/lib/crash-context.ts";

interface CrashBoundaryProps {
	children: ReactNode;
}

interface CrashBoundaryState {
	/** React component stack from componentDidCatch (names the failing component). */
	componentStack: string | null;
	copied: boolean;
	error: Error | null;
	hasError: boolean;
}

// Stack-frame parsing regexes (top-level per the code standards). Handle both
// WebKit (`name@url`) and Chromium (`at name (url)`) frame formats — the desktop
// runs in WKWebView but a dev may reproduce in Chromium.
const FRAME_URL_RE = /https?:\/\/[^\s)]+/;
const TRAILING_PARENS_RE = /\)+$/;
const ORIGIN_RE = /^https?:\/\/[^/]+\//;
const VITE_FS_RE = /^@fs\//;
const REPO_ROOT_RE = /^.*\/ryu-closed\//;
const WEBKIT_NAME_RE = /^([^@\s]+)@/;
const CHROMIUM_NAME_RE = /^at\s+([^\s(]+)\s*\(/;

/**
 * Pull the first *app* source frame out of an error stack, skipping bundler and
 * dependency frames (Vite deps, node_modules), rendered as `name (path:line:col)`
 * relative to the dev origin. Best-effort: returns null when no app frame is
 * recognizable.
 */
function firstAppFrame(stack: string | undefined): string | null {
	if (!stack) {
		return null;
	}
	for (const raw of stack.split("\n")) {
		const line = raw.trim();
		const urlMatch = line.match(FRAME_URL_RE);
		if (!urlMatch) {
			continue;
		}
		const url = urlMatch[0].replace(TRAILING_PARENS_RE, "");
		if (url.includes("/node_modules/") || url.includes("/.vite/")) {
			continue;
		}
		const rel = url
			.replace(ORIGIN_RE, "")
			.replace(VITE_FS_RE, "")
			.replace(REPO_ROOT_RE, "");
		const name =
			line.match(WEBKIT_NAME_RE)?.[1] ??
			line.match(CHROMIUM_NAME_RE)?.[1] ??
			null;
		return name ? `${name} (${rel})` : rel;
	}
	return null;
}

export class CrashBoundary extends Component<
	CrashBoundaryProps,
	CrashBoundaryState
> {
	constructor(props: CrashBoundaryProps) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
			copied: false,
			componentStack: null,
		};
	}

	static getDerivedStateFromError(error: Error): CrashBoundaryState {
		return { hasError: true, error, copied: false, componentStack: null };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Keep the React component stack for the dev "Copy console" action — it names
		// the failing component (e.g. <EditorRefPluginEffect>), which the raw JS stack
		// often doesn't. State-only; never sent to the network.
		this.setState({ componentStack: info.componentStack ?? null });
		// Gated inside reportError(): a no-op unless crash reports are consented +
		// a DSN is set. The error is PII-scrubbed in crash.ts's beforeSend.
		reportError(error);
	}

	handleReload = (): void => {
		this.setState({
			hasError: false,
			error: null,
			copied: false,
			componentStack: null,
		});
		window.location.reload();
	};

	// Dev-only: copy the crash stack + recent console output to the clipboard so a
	// developer can paste it into a bug report without scrolling devtools.
	handleCopyConsole = async (): Promise<void> => {
		const parts: string[] = [];
		const { error, componentStack } = this.state;

		// Context header: where the user was + which file/component blew up, so a
		// pasted report is self-explanatory without re-deriving it from the stack.
		const route = getCrashRoute();
		if (route) {
			parts.push(
				`Route: ${route.path}${route.title ? ` — ${route.title}` : ""}`
			);
		}
		const frame = firstAppFrame(error?.stack);
		if (frame) {
			parts.push(`Source: ${frame}`);
		}
		if (route || frame) {
			parts.push("");
		}

		if (error) {
			parts.push(error.stack ?? `${error.name}: ${error.message}`, "");
		}
		if (componentStack) {
			parts.push("Component stack:", componentStack.trim(), "");
		}
		parts.push(getConsoleBufferText());
		try {
			await navigator.clipboard.writeText(parts.join("\n"));
			this.setState({ copied: true });
		} catch {
			// Clipboard writes can reject without focus/permission; nothing to do.
		}
	};

	render(): ReactNode {
		if (this.state.hasError) {
			// CrashBoundary renders OUTSIDE PageWrapper, so PageWrapper's
			// `bg-background` surface is gone when the fallback shows. The body is
			// intentionally transparent (see index.css), so we must paint the
			// rounded window surface here ourselves, otherwise the error screen
			// shows through with no background and square corners.
			return (
				<div
					className="/50 flex h-screen w-full items-center justify-center overflow-hidden rounded-[var(--ryu-window-radius-base,2rem)] bg-background backdrop-blur-xl"
					data-tauri-drag-region
				>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon className="size-6" icon={Alert02Icon} />
							</EmptyMedia>
							<EmptyTitle>Something went wrong</EmptyTitle>
							<EmptyDescription>
								The app hit an unexpected error. Reloading usually fixes it. If
								you have crash reports on, a scrubbed report was sent so we can
								fix it.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<div className="flex items-center gap-2">
								<Button onClick={this.handleReload} size="sm">
									Reload
								</Button>
								{import.meta.env.DEV ? (
									<Button
										onClick={this.handleCopyConsole}
										size="sm"
										variant="ghost"
									>
										{this.state.copied ? "Copied" : "Copy console"}
									</Button>
								) : null}
							</div>
						</EmptyContent>
					</Empty>
				</div>
			);
		}
		return this.props.children;
	}
}
