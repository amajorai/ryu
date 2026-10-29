import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { BellRing, Store } from "lucide-react";
import { type ReactNode, useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import {
	type MarketShop,
	shopKindText,
	shopLabel,
	shopState,
} from "./market-model.ts";

/**
 * The market street as a plain list, for stages without WebGL (and tests):
 * every shop the diorama shows, as the same controls (a shop opens its
 * sheet; a shopkeeper opens it with an order addressed to them).
 */
export function MarketList({
	acts,
	onOpenKeeper,
	onOpenShop,
	selectedShopId,
	shops,
}: {
	/**
	 * With the act layer: each shopkeeper's row (at its home shop only) is
	 * described by its act sentence and followed by its `ActStatus`.
	 */
	acts?: {
		/** The shop each agent keeps in the act layout. */
		home: ReadonlyMap<string, string>;
		/** Each shop's blocking asks. */
		needYou: ReadonlyMap<string, number>;
		sentence: (agentId: string) => string | null;
		status: (agentId: string) => ReactNode;
	};
	onOpenKeeper: (shopId: string, agentId: string) => void;
	onOpenShop: (shopId: string) => void;
	selectedShopId: string | null;
	shops: readonly MarketShop[];
}) {
	const tl = useLiteralMessages();
	const baseId = useId();
	return (
		<div
			className="absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pt-24 pb-28"
			data-testid="market-list"
		>
			<ul className="mx-auto flex max-w-3xl flex-col gap-4">
				{shops.map((shop) => (
					<li
						className={cn(GAME_PLATE, "flex flex-col gap-3 p-4")}
						data-kind={shop.kind}
						key={shop.id}
					>
						<button
							aria-current={selectedShopId === shop.id ? "true" : undefined}
							aria-label={shopLabel(shop, acts?.needYou.get(shop.id))}
							className={cn(
								GAME_FOCUS,
								"flex items-center gap-3 rounded-lg px-2 py-1 text-start hover:bg-(--gk-plate-sunk)"
							)}
							data-testid="market-shop"
							onClick={() => onOpenShop(shop.id)}
							type="button"
						>
							<Store aria-hidden="true" className="size-5 shrink-0" />
							<span className="flex min-w-0 flex-col">
								<span className="gk-display truncate text-[17px]">
									{shop.name}
								</span>
								<span className="text-(--gk-ink-muted) text-[13px]">
									{shopKindText(shop)} · {shopState(shop)}
								</span>
							</span>
							{acts ? (
								(acts.needYou.get(shop.id) ?? 0) > 0 ? (
									<span className="ms-auto flex items-center gap-1 font-semibold text-[13px] tabular-nums">
										<BellRing aria-hidden="true" className="size-4" />
										{tl("{needYou} need you", {
											needYou: acts.needYou.get(shop.id) ?? 0,
										})}
									</span>
								) : null
							) : shop.waitingOnYou > 0 ? (
								<span className="ms-auto flex items-center gap-1 font-semibold text-[13px] tabular-nums">
									<BellRing aria-hidden="true" className="size-4" />
									{tl("{waitingOnYou} waiting", {
										waitingOnYou: shop.waitingOnYou,
									})}
								</span>
							) : null}
						</button>
						{shop.agents.length > 0 ? (
							<ul
								aria-label={tl("Shopkeepers at {shopName}", {
									shopName: shop.name,
								})}
								className={
									acts ? "flex flex-col gap-2" : "flex flex-wrap gap-2"
								}
							>
								{shop.agents.map((agent) => {
									const home = acts?.home.get(agent.id) === shop.id;
									const sentence = home ? acts?.sentence(agent.id) : null;
									const describedBy = `${baseId}-${shop.id}-${agent.id}`;
									return (
										<li
											className={
												acts ? "flex flex-wrap items-center gap-2" : undefined
											}
											key={agent.id}
										>
											{sentence ? (
												<span className="sr-only" id={describedBy}>
													{sentence}
												</span>
											) : null}
											<button
												aria-describedby={sentence ? describedBy : undefined}
												aria-label={tl(
													"Place an order with {agentName} at {shopName}",
													{ agentName: agent.name, shopName: shop.name }
												)}
												className={cn(
													GAME_FOCUS,
													"rounded-full border-(--gk-plate-sunk) border-2 px-3 py-1 font-semibold text-[13px] hover:bg-(--gk-plate-sunk)"
												)}
												data-act-agent={sentence ? agent.id : undefined}
												onClick={() => onOpenKeeper(shop.id, agent.id)}
												type="button"
											>
												{agent.name}
											</button>
											{home ? acts?.status(agent.id) : null}
										</li>
									);
								})}
							</ul>
						) : null}
					</li>
				))}
			</ul>
		</div>
	);
}
