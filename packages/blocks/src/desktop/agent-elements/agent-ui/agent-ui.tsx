// <AgentUI/> — renders an agent-emitted json-render spec into `@ryu/ui` components.
//
// Resilience is the priority: a malformed or partial spec must never crash the
// chat. We do a light structural check and fall back to a readable error + the raw
// JSON, render unknown component types through a small inert fallback, and wrap the
// renderer in an error boundary as a final backstop. We intentionally do NOT gate on
// `catalog.validate()` — it requires a `visible` field on every element, which valid
// model output omits; `<Renderer>` is lenient and treats missing fields as defaults.
//
// While the tool input is still arriving (`streaming`), whatever elements exist are
// drawn progressively: the renderer's `loading` mode skips child keys that haven't
// arrived yet, a render error shows a quiet placeholder instead of the raw JSON (the
// next update retries), and actions stay disabled. The state provider remounts when
// streaming ends so the final spec's `state` seeds bound inputs.
//
// With a `persistKey` (the tool call id) and a desktop-injected state host, the
// widget's state and submitted flag are saved as the user interacts and restored
// when the conversation is reopened, so a checklist stays checked.

import {
	createStateStore,
	type ResolvedAction,
	type StateModel,
} from "@json-render/core";
import {
	type ComponentRenderProps,
	JSONUIProvider,
	Renderer,
	type Spec,
} from "@json-render/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Component,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { normalizeA2ui } from "./a2ui.ts";
import { agentUiFunctions } from "./computed.ts";
import { registry } from "./registry.tsx";
import { initialStateFor, renderSpecHeaderSchema } from "./render-spec.ts";
import {
	type AgentUiSavedState,
	useAgentUiStateHost,
} from "./state-host-context.tsx";
import { AgentUiSubmissionStateProvider } from "./submission-context.tsx";

// Rendered for any element whose `type` is not in the registry — keep it inert and
// quiet rather than throwing, so one bad node doesn't sink the whole UI.
function UnknownComponent({ element }: ComponentRenderProps) {
	const tl = useLiteralMessages();
	return (
		<span className="text-muted-foreground text-xs">
			{tl("[unknown component: {componentType}]", {
				componentType: String(element.type),
			})}
		</span>
	);
}

type AgentUiSubmissionValue = NonNullable<ResolvedAction["params"]>["value"];
type AgentUiSubmissionHandler = (
	value: AgentUiSubmissionValue
) => void | Promise<void>;

interface AgentUIProps {
	className?: string;
	/** Input protocol. A2UI is normalized into the closed native catalog. */
	format?: "json-render" | "a2ui";
	/** Receives values from the spec's `submit` action. */
	onSubmit?: AgentUiSubmissionHandler;
	/** Stable id (the tool call id) under which the widget's state is saved and
	 *  restored through the injected state host. Omit to keep state in memory. */
	persistKey?: string;
	/** Heading saved with the widget's state (so `ui.get_state` can name it) when
	 *  the caller draws the title itself instead of passing `title`. */
	persistTitle?: string;
	/** The json-render spec emitted by the agent (tool input). */
	spec: unknown;
	/** The spec is still arriving; draw what exists and keep actions disabled. */
	streaming?: boolean;
	/** Optional heading shown above the rendered UI. */
	title?: string;
}

interface AgentUiActionParams {
	value?: AgentUiSubmissionValue;
}

export type AgentUiActionHandlers = ReturnType<
	typeof createAgentUiActionHandlers
>;

export function createAgentUiActionHandlers(
	onSubmit?: AgentUiSubmissionHandler
) {
	return {
		submit: async (params: AgentUiActionParams) => {
			if (onSubmit && "value" in params) {
				await onSubmit(params.value);
			}
		},
	};
}

interface RawSpecFallbackProps {
	reason: string;
	spec: unknown;
}

function RawSpecFallback({ reason, spec }: RawSpecFallbackProps) {
	let json: string;
	try {
		json = JSON.stringify(spec, null, 2);
	} catch {
		json = String(spec);
	}
	return (
		<div className="rounded-lg border border-border bg-muted/40 p-3">
			<p className="mb-1.5 font-medium text-muted-foreground text-xs">
				{reason}
			</p>
			<pre className="max-h-64 overflow-auto text-foreground/70 text-xs">
				<code>{json}</code>
			</pre>
		</div>
	);
}

function StreamingPlaceholder() {
	return (
		<p
			aria-live="polite"
			className="text-muted-foreground text-xs motion-safe:animate-skeleton"
			role="status"
		>
			Rendering UI…
		</p>
	);
}

interface BoundaryProps {
	children: ReactNode;
	fallback: ReactNode;
	/** A new value clears a caught error so the next spec update can retry. */
	resetKey: unknown;
}
interface BoundaryState {
	hasError: boolean;
}

// React error boundaries have no functional equivalent, so a class is required here.
// biome-ignore lint/style/useReactFunctionComponents: error boundaries must be class components
class RenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
	constructor(props: BoundaryProps) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(): BoundaryState {
		return { hasError: true };
	}

	componentDidUpdate(previous: BoundaryProps) {
		if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
			this.setState({ hasError: false });
		}
	}

	render() {
		if (this.state.hasError) {
			return this.props.fallback;
		}
		return this.props.children;
	}
}

/** Quiet period before a burst of edits (typing, dragging a slider) is saved. */
const SAVE_DEBOUNCE_MS = 400;

type AgentUiPersist = (saved: AgentUiSavedState) => void;

/**
 * Owns the json-render state store for one mount, seeded from saved or spec
 * state, and reports every change. Keyed by the caller so the store is rebuilt
 * when streaming ends or saved state is reloaded.
 */
function AgentUiStateScope({
	children,
	handlers,
	onChange,
	seed,
}: {
	children: ReactNode;
	handlers: AgentUiActionHandlers;
	onChange: (state: StateModel) => void;
	seed: StateModel | undefined;
}) {
	const [store] = useState(() => createStateStore(seed ?? {}));
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(
		() => store.subscribe(() => onChangeRef.current(store.getSnapshot())),
		[store]
	);
	return (
		<JSONUIProvider
			functions={agentUiFunctions}
			handlers={handlers}
			registry={registry}
			store={store}
		>
			{children}
		</JSONUIProvider>
	);
}

export function AgentUI(props: AgentUIProps) {
	const host = useAgentUiStateHost();
	const { persistKey, streaming } = props;
	const persisting = Boolean(host && persistKey && !streaming);
	const saved = persisting && persistKey ? host?.read(persistKey) : undefined;
	const persist = useCallback<AgentUiPersist>(
		(next) => {
			if (host && persistKey) {
				host.write(persistKey, next);
			}
		},
		[host, persistKey]
	);
	return (
		<AgentUIView
			// Remount when the server copy (re)loads so restored state seeds the store.
			key={persisting ? `saved-${host?.version ?? 0}` : "memory"}
			{...props}
			persist={persisting ? persist : undefined}
			saved={saved}
		/>
	);
}

function AgentUIView({
	className,
	format = "json-render",
	onSubmit,
	persist,
	persistTitle,
	saved,
	spec,
	streaming = false,
	title,
}: AgentUIProps & {
	persist?: AgentUiPersist;
	saved?: AgentUiSavedState;
}) {
	const submit = onSubmit;
	const [pending, setPending] = useState(false);
	const [submitted, setSubmitted] = useState(saved?.submitted === true);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const normalized = format === "a2ui" ? normalizeA2ui(spec) : null;
	const renderSpec = normalized?.spec ?? spec;
	const seed = saved?.state ?? initialStateFor(renderSpec);

	// Debounced save of the latest state; flushed on unmount so an edit made just
	// before switching chats or scrolling the widget away is not lost.
	const latestStateRef = useRef<StateModel | undefined>(undefined);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const submittedRef = useRef(submitted);
	submittedRef.current = submitted;
	const persistRef = useRef(persist);
	persistRef.current = persist;
	const titleRef = useRef(title ?? persistTitle);
	titleRef.current = title ?? persistTitle;
	const flushSave = useCallback(() => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		const state = latestStateRef.current;
		if (state) {
			persistRef.current?.({
				state,
				submitted: submittedRef.current,
				...(titleRef.current ? { title: titleRef.current } : {}),
			});
		}
	}, []);
	const handleStateChange = useCallback(
		(state: StateModel) => {
			latestStateRef.current = state;
			if (!persistRef.current) {
				return;
			}
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
			}
			saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
		},
		[flushSave]
	);
	useEffect(() => flushSave, [flushSave]);

	const handleSubmit = useCallback(
		async (value: AgentUiSubmissionValue) => {
			if (!submit || pending || submitted) {
				return;
			}
			setPending(true);
			setSubmitError(null);
			try {
				await submit(value);
				setSubmitted(true);
				submittedRef.current = true;
				latestStateRef.current ??= seed ?? {};
				flushSave();
			} catch (error) {
				setSubmitError(
					error instanceof Error ? error.message : "Submission failed"
				);
				throw error;
			} finally {
				setPending(false);
			}
		},
		[flushSave, pending, seed, submit, submitted]
	);
	const renderHeader = renderSpecHeaderSchema.safeParse(renderSpec);
	if (!renderHeader.success) {
		if (streaming) {
			return <StreamingPlaceholder />;
		}
		return (
			<RawSpecFallback
				reason="This UI spec couldn't be rendered."
				spec={spec}
			/>
		);
	}

	// SAFETY: Installed json-render Renderer consumes this checked raw header and
	// owns legacy node fields, inherited lookup, and rendering error timing. Its
	// declared Spec ABI is narrower than that native protocol; do not use this
	// adapter value for local node/property reads or a whole-node validation claim.
	const nativeSpec = renderHeader.data as Spec;

	return (
		<div className={cn("flex flex-col gap-2", className)} data-slot="agent-ui">
			{title && (
				<h3 className="font-medium text-foreground/80 text-xs">{title}</h3>
			)}
			<RenderErrorBoundary
				fallback={
					streaming ? (
						<StreamingPlaceholder />
					) : (
						<RawSpecFallback reason="This UI failed to render." spec={spec} />
					)
				}
				resetKey={spec}
			>
				<AgentUiSubmissionStateProvider
					state={{ pending: pending || streaming, submitted }}
				>
					<AgentUiStateScope
						handlers={createAgentUiActionHandlers(
							streaming ? undefined : handleSubmit
						)}
						key={streaming ? "streaming" : "final"}
						onChange={handleStateChange}
						seed={seed}
					>
						<Renderer
							fallback={UnknownComponent}
							loading={streaming}
							registry={registry}
							spec={nativeSpec}
						/>
					</AgentUiStateScope>
				</AgentUiSubmissionStateProvider>
			</RenderErrorBoundary>
			{submitError ? (
				<p
					aria-live="polite"
					className="text-status-destructive text-xs"
					role="alert"
				>
					{submitError}
				</p>
			) : pending ? (
				<p
					aria-live="polite"
					className="text-muted-foreground text-xs"
					role="status"
				>
					Submitting…
				</p>
			) : submitted ? (
				<p
					aria-live="polite"
					className="text-muted-foreground text-xs"
					role="status"
				>
					Submitted
				</p>
			) : null}
		</div>
	);
}
