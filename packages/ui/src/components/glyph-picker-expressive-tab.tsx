"use client";

import { EXPRESSIVE_EXPRESSION_OPTIONS } from "@ryu/ui/components/expressive.ts";
import { EXPRESSIVE_ANIMATION_OPTIONS } from "@ryu/ui/components/expressive-animation.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { GhostAvatarControls } from "./ghost-avatar-controls.tsx";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerExpressiveTab({
	state,
}: {
	state: GlyphPickerState;
}) {
	const {
		ghostAppearance,
		setGhostAppearance,
		expressiveSelection,
		setExpressiveSelection,
		expressiveAnimationSelection,
		setExpressiveAnimationSelection,
	} = state;
	return (
		<TabsContent className="pt-3" value="expressive">
			<div className="space-y-3">
				<div className="flex min-h-36 items-center justify-center rounded-lg bg-muted/30">
					<GlyphDisplay
						alt="Expressive Ryu avatar preview"
						className="text-foreground"
						size={96}
						value={{
							...ghostAppearance,
							animation: expressiveAnimationSelection,
							kind: "expressive",
							expression: expressiveSelection,
						}}
					/>
				</div>
				<GhostAvatarControls
					onChange={setGhostAppearance}
					value={ghostAppearance}
				/>
				<p
					className="text-muted-foreground text-xs"
					hidden={ghostAppearance.variant === "costume"}
				>
					Choose a mood and animation, or use Random to cycle. The live preview
					uses your selected appearance.
				</p>
				<div
					className="h-72 overflow-hidden rounded-lg border border-border"
					hidden={
						ghostAppearance.behavior === "conversation" ||
						ghostAppearance.variant === "costume"
					}
				>
					<ScrollArea className="h-full">
						<div className="space-y-3 p-2">
							<div>
								<p className="mb-1.5 font-medium text-muted-foreground text-xs">
									Expression
								</p>
								<div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
									{EXPRESSIVE_EXPRESSION_OPTIONS.map((option) => {
										const active = expressiveSelection === option.value;
										return (
											<button
												aria-label={option.label}
												aria-pressed={active}
												className={cn(
													"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
													active && "bg-accent ring-2 ring-primary"
												)}
												key={option.value}
												onClick={() => setExpressiveSelection(option.value)}
												title={option.description}
												type="button"
											>
												<GlyphDisplay
													alt=""
													animated={false}
													className="size-11"
													size={44}
													value={{
														animation: expressiveAnimationSelection,
														kind: "expressive",
														expression: option.value,
													}}
												/>
												<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
													{option.label}
												</span>
											</button>
										);
									})}
								</div>
								<div className="border-border border-t pt-2">
									<p className="mb-1.5 font-medium text-muted-foreground text-xs">
										Animation
									</p>
									<div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
										{EXPRESSIVE_ANIMATION_OPTIONS.map((option) => {
											const active =
												expressiveAnimationSelection === option.value;
											return (
												<button
													aria-label={option.label}
													aria-pressed={active}
													className={cn(
														"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
														active && "bg-accent ring-2 ring-primary"
													)}
													key={option.value}
													onClick={() =>
														setExpressiveAnimationSelection(option.value)
													}
													title={option.description}
													type="button"
												>
													<GlyphDisplay
														alt=""
														animated={false}
														className="size-11"
														size={44}
														value={{
															animation: option.value,
															kind: "expressive",
															expression: expressiveSelection,
														}}
													/>
													<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
														{option.label}
													</span>
												</button>
											);
										})}
									</div>
								</div>
							</div>
						</div>
					</ScrollArea>
				</div>
			</div>
		</TabsContent>
	);
}
