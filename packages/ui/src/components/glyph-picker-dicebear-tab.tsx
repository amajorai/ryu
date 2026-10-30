"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import {
	DICEBEAR_STYLES,
	dicebearStyleLabel,
	dicebearUrl,
	randomDicebearSeed,
} from "@ryu/ui/components/glyph.ts";
import { Input } from "@ryu/ui/components/input.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { RefreshCw } from "lucide-react";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerDicebearTab({ state }: { state: GlyphPickerState }) {
	const { diceStyle, setDiceStyle, diceSeed, setDiceSeed } = state;
	return (
		<TabsContent className="pt-3" value="dicebear">
			<div className="space-y-3">
				<div className="flex h-28 items-center justify-center rounded-lg bg-muted/30">
					{}
					{}
					<img
						alt=""
						className="size-20 rounded-lg"
						src={dicebearUrl(diceStyle, diceSeed, { size: 80 })}
					/>
				</div>

				<div className="flex items-center gap-2">
					<Input
						aria-label="DiceBear seed"
						onChange={(e) => setDiceSeed(e.target.value)}
						placeholder="Seed"
						value={diceSeed}
					/>
					<Button
						aria-label="Randomize seed"
						onClick={() => setDiceSeed(randomDicebearSeed())}
						size="icon"
						type="button"
						variant="outline"
					>
						<RefreshCw className="size-4" />
					</Button>
				</div>

				<div className="h-44 overflow-hidden rounded-lg border border-border">
					<ScrollArea className="h-full">
						<div className="grid grid-cols-5 gap-1.5 p-2">
							{DICEBEAR_STYLES.map((style) => {
								const active = diceStyle === style;
								return (
									<button
										aria-label={dicebearStyleLabel(style)}
										aria-pressed={active}
										className={cn(
											"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
											active && "bg-accent ring-2 ring-primary"
										)}
										key={style}
										onClick={() => setDiceStyle(style)}
										title={dicebearStyleLabel(style)}
										type="button"
									>
										{}
										{}
										<img
											alt=""
											className="size-10 rounded-md"
											src={dicebearUrl(style, diceSeed || "preview", {
												size: 40,
											})}
										/>
										<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
											{dicebearStyleLabel(style)}
										</span>
									</button>
								);
							})}
						</div>
					</ScrollArea>
				</div>
			</div>
		</TabsContent>
	);
}
