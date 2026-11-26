import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	BOT_LANES_POLL_MS,
	BOT_LIVE_VIEW_POLL_MS,
	type BotLane,
	type BotLaneSelection,
	type BotLiveFrame,
	botLaneScreencastPath,
	parseBotLanes,
	parseBotLiveFrame,
	pickBotLaneTab,
} from "./browser-bot-lanes.ts";
import {
	BOT_TAKEOVER_POLL_MS,
	type BotTakeoverAction,
	botTakeoverFailure,
	botTakeoverPath,
} from "./browser-bot-takeover.ts";
import {
	BrowserBotTakeoverCard,
	BrowserBotTakeoverSurface,
} from "./browser-bot-takeover.tsx";

export type BrowserSidecarCall = (
	path: string,
	init?: RequestInit
) => Promise<Response>;

/**
 * Live view of the agents' hidden Bot lanes in the browser sidecar. Lists
 * every open lane and shows the watched tab's screencast. The view is
 * read-only, except while its owner has taken over a tab an agent asked them
 * to act in (`browser-bot-takeover.tsx`): then their input goes to that tab
 * until they choose Done or the request runs out. Polling stops while the
 * panel is hidden, and the watched tab's screencast is released when the
 * selection changes or the view closes.
 */
export function BrowserBotLiveView({
	active,
	base,
	call,
	headers,
}: {
	active: boolean;
	base: string;
	call: BrowserSidecarCall;
	/** The sidecar call's own headers, repeated on requests that carry a body. */
	headers?: Record<string, string>;
}) {
	const tl = useLiteralMessages();
	const [lanes, setLanes] = useState<BotLane[]>([]);
	const [selection, setSelection] = useState<BotLaneSelection | null>(null);
	const [frame, setFrame] = useState<BotLiveFrame | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [answering, setAnswering] = useState(false);
	const [takeoverError, setTakeoverError] = useState<string | null>(null);
	const pollMs = useRef(BOT_LIVE_VIEW_POLL_MS);
	const doneId = useId();

	const loadLanes = useCallback(async () => {
		try {
			const resp = await call(`${base}/lanes`);
			const next = parseBotLanes(await resp.json());
			setLanes(next);
			setSelection((current) => pickBotLaneTab(next, current));
			setError(null);
		} catch (e) {
			setError(
				tl("Agent browser sessions are unavailable ({reason})", {
					reason: e instanceof Error ? e.message : tl("error"),
				})
			);
		}
	}, [base, call, tl]);

	const refreshLanes = useCallback(() => {
		loadLanes().catch(() => undefined);
	}, [loadLanes]);

	useEffect(() => {
		if (!active) {
			return;
		}
		loadLanes().catch(() => undefined);
		const timer = window.setInterval(() => {
			loadLanes().catch(() => undefined);
		}, BOT_LANES_POLL_MS);
		return () => window.clearInterval(timer);
	}, [active, loadLanes]);

	useEffect(() => {
		setFrame(null);
		if (!(active && selection)) {
			return;
		}
		const path = botLaneScreencastPath(base, selection);
		let inFlight = false;
		let cancelled = false;
		const tick = () => {
			if (inFlight) {
				return;
			}
			inFlight = true;
			call(path)
				.then((resp) => resp.json())
				.then((body: unknown) => {
					const next = parseBotLiveFrame(body);
					if (!(cancelled || next === null)) {
						setFrame((prev) => (prev?.seq === next.seq ? prev : next));
					}
				})
				.catch(() => {
					if (!cancelled) {
						// The tab closed or the view is unavailable: refresh the lanes.
						loadLanes().catch(() => undefined);
					}
				})
				.finally(() => {
					inFlight = false;
				});
		};
		let timer = 0;
		const loop = () => {
			tick();
			timer = window.setTimeout(loop, pollMs.current);
		};
		loop();
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			call(path, { method: "DELETE" }).catch(() => undefined);
		};
	}, [active, base, call, loadLanes, selection]);

	const watchedLane = lanes.find((lane) => lane.agentId === selection?.agentId);
	const watchedTab = watchedLane?.tabs.find(
		(tab) => tab.id === selection?.tabId
	);
	const takeover =
		watchedLane?.takeover?.tabId === selection?.tabId
			? watchedLane?.takeover
			: undefined;
	const controlling = takeover?.status === "active";
	// The picture follows the owner's input more closely while they have control.
	pollMs.current = controlling ? BOT_TAKEOVER_POLL_MS : BOT_LIVE_VIEW_POLL_MS;

	const answerTakeover = useCallback(
		async (action: BotTakeoverAction) => {
			if (!selection) {
				return;
			}
			setAnswering(true);
			setTakeoverError(null);
			try {
				await call(botTakeoverPath(base, selection), {
					body: JSON.stringify({ action }),
					headers: { ...headers, "Content-Type": "application/json" },
					method: "POST",
				});
			} catch (e) {
				const failure = botTakeoverFailure(e);
				if (failure === "busy") {
					setTakeoverError(
						tl("The agent is still working in this tab. Try again in a moment.")
					);
				} else if (failure === "other") {
					setTakeoverError(
						tl("The takeover could not be updated ({reason})", {
							reason: e instanceof Error ? e.message : tl("error"),
						})
					);
				}
			} finally {
				setAnswering(false);
				await loadLanes();
			}
		},
		[base, call, headers, loadLanes, selection, tl]
	);

	return (
		<div className="flex min-h-0 flex-1">
			<ul
				aria-label="Agent browser sessions"
				className="w-48 shrink-0 overflow-y-auto border-border border-e text-xs"
			>
				{lanes.length === 0 && (
					<li className="p-2 text-muted-foreground">
						No agent is using the browser.
					</li>
				)}
				{lanes.map((lane) => (
					<li className="border-border border-b" key={lane.agentId}>
						<p
							className="truncate px-2 pt-1.5 font-medium text-muted-foreground"
							title={lane.agentId}
						>
							{lane.agentId}
						</p>
						<ul>
							{lane.tabs.length === 0 && (
								<li className="px-2 py-1 text-muted-foreground">No tabs.</li>
							)}
							{lane.tabs.map((tab) => (
								<li key={tab.id}>
									<button
										aria-pressed={
											selection?.agentId === lane.agentId &&
											selection.tabId === tab.id
										}
										className={cn(
											"w-full truncate px-2 py-1 text-start hover:bg-accent",
											selection?.agentId === lane.agentId &&
												selection.tabId === tab.id &&
												"bg-accent"
										)}
										onClick={() =>
											setSelection({ agentId: lane.agentId, tabId: tab.id })
										}
										title={tab.url}
										type="button"
									>
										{lane.takeover?.tabId === tab.id && (
											<span className="me-1 rounded bg-primary px-1 text-primary-foreground">
												Needs you
											</span>
										)}
										{tab.title || tab.url || tab.id}
									</button>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
			<div className="flex min-w-0 flex-1 flex-col">
				{takeover && watchedLane && (
					<BrowserBotTakeoverCard
						agentId={watchedLane.agentId}
						busy={answering}
						doneId={doneId}
						error={takeoverError}
						onAnswer={answerTakeover}
						takeover={takeover}
					/>
				)}
				<div className="relative flex min-h-0 flex-1 items-center justify-center bg-muted/30">
					{error && (
						<div className="absolute start-2 end-2 top-2 z-10 rounded-lg border border-border bg-popover px-2 py-1 text-center text-status-destructive text-xs shadow-lg">
							{error}
						</div>
					)}
					{frame && watchedTab ? (
						<figure className="flex h-full w-full flex-col">
							<div className="relative min-h-0 flex-1">
								<img
									alt={tl("Live view of {page}", {
										page: watchedTab.title || watchedTab.url,
									})}
									className="h-full w-full object-contain"
									height={frame.height || undefined}
									src={frame.src}
									width={frame.width || undefined}
								/>
								{controlling && selection && (
									<BrowserBotTakeoverSurface
										base={base}
										call={call}
										frame={frame}
										headers={headers}
										label={tl("Page of {agent}, under your control", {
											agent: watchedLane?.agentId ?? "",
										})}
										onLeave={() => document.getElementById(doneId)?.focus()}
										onRefused={refreshLanes}
										selection={selection}
									/>
								)}
							</div>
							<figcaption className="truncate border-border border-t px-2 py-1 text-muted-foreground text-xs">
								{controlling
									? tl("You control {agent} · {url}", {
											agent: watchedLane?.agentId ?? "",
											url: watchedTab.url,
										})
									: tl("Watching {agent} · read-only · {url}", {
											agent: watchedLane?.agentId ?? "",
											url: watchedTab.url,
										})}
							</figcaption>
						</figure>
					) : (
						<p className="text-muted-foreground text-xs">
							{selection
								? "Waiting for the agent's page…"
								: "Pick an agent tab to watch it live."}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
