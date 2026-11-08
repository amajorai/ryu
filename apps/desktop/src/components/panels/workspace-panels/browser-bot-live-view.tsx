import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useState } from "react";
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

export type BrowserSidecarCall = (
	path: string,
	init?: RequestInit
) => Promise<Response>;

/**
 * Read-only live view of the agents' hidden Bot lanes in the browser sidecar.
 * Lists every open lane and shows the watched tab's screencast; it never sends
 * input to a lane. Polling stops while the panel is hidden, and the watched
 * tab's screencast is released when the selection changes or the view closes.
 */
export function BrowserBotLiveView({
	active,
	base,
	call,
}: {
	active: boolean;
	base: string;
	call: BrowserSidecarCall;
}) {
	const tl = useLiteralMessages();
	const [lanes, setLanes] = useState<BotLane[]>([]);
	const [selection, setSelection] = useState<BotLaneSelection | null>(null);
	const [frame, setFrame] = useState<BotLiveFrame | null>(null);
	const [error, setError] = useState<string | null>(null);

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
		tick();
		const timer = window.setInterval(tick, BOT_LIVE_VIEW_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			call(path, { method: "DELETE" }).catch(() => undefined);
		};
	}, [active, base, call, loadLanes, selection]);

	const watchedLane = lanes.find((lane) => lane.agentId === selection?.agentId);
	const watchedTab = watchedLane?.tabs.find(
		(tab) => tab.id === selection?.tabId
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
										{tab.title || tab.url || tab.id}
									</button>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
			<div className="relative flex min-w-0 flex-1 items-center justify-center bg-muted/30">
				{error && (
					<div className="absolute start-2 end-2 top-2 z-10 rounded-lg border border-border bg-popover px-2 py-1 text-center text-status-destructive text-xs shadow-lg">
						{error}
					</div>
				)}
				{frame && watchedTab ? (
					<figure className="flex h-full w-full flex-col">
						<img
							alt={tl("Live view of {page}", {
								page: watchedTab.title || watchedTab.url,
							})}
							className="min-h-0 flex-1 object-contain"
							height={frame.height || undefined}
							src={frame.src}
							width={frame.width || undefined}
						/>
						<figcaption className="truncate border-border border-t px-2 py-1 text-muted-foreground text-xs">
							{tl("Watching {agent} · read-only · {url}", {
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
	);
}
