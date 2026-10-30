import { EngineFootnote } from "@ryu/blocks/desktop/store-engines.tsx";
import { useRichLiteralMessages } from "@ryu/i18n/react";
import { ListingSection } from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useLlamacppAcceleration } from "@/src/hooks/useLlamacppAcceleration.ts";

/**
 * CPU-vs-GPU build picker for llama.cpp.
 *
 * Written for someone who does not know what CUDA, Metal or Vulkan are: the
 * first line states what is happening right now in plain words, "Automatic" is
 * the default and is marked recommended, and the builds this device cannot
 * run are visibly disabled with the reason next to them rather than hidden
 * (hiding them makes the list look arbitrary; showing why is what teaches).
 */
export function EngineAccelerationSection() {
	const { acceleration, loading, switching, error, select } =
		useLlamacppAcceleration();
	const tlRich = useRichLiteralMessages();

	if (loading && !acceleration) {
		return (
			<ListingSection title="Speed">
				<SkeletonRows />
			</ListingSection>
		);
	}
	if (!acceleration) {
		return null;
	}

	const { selected, resolvedLabel, hasGpu, gpuName, vram, options } =
		acceleration;
	const hardware = hasGpu
		? `Graphics card detected${gpuName ? `: ${gpuName}` : ""}${vram ? ` (${vram})` : ""}.`
		: "No usable graphics card detected on this device.";

	return (
		<ListingSection title="Speed">
			<p className="text-muted-foreground text-sm leading-relaxed">
				{tlRich(
					"{hardware} Right now this engine runs on <span>{resolvedLabel}</span>. Leave this on Automatic unless something is going wrong — Ryu picks the fastest option your device can actually run.",
					{ hardware, resolvedLabel },
					{ span: (c) => <span className="text-foreground">{c}</span> }
				)}
			</p>
			<RadioGroup
				aria-label="How llama.cpp runs"
				className="mt-3"
				disabled={switching}
				onValueChange={(value) => {
					void select(String(value));
				}}
				value={selected}
			>
				<div className="flex items-start gap-2.5">
					<RadioGroupItem
						className="mt-0.5"
						id="llamacpp-accel-auto"
						value="auto"
					/>
					<div className="flex flex-col gap-0.5">
						<Label htmlFor="llamacpp-accel-auto" variant="choice">
							Automatic
							<Badge variant="secondary">Recommended</Badge>
						</Label>
						<p className="text-muted-foreground text-xs">
							Detects your hardware and uses the fastest option available.
						</p>
					</div>
				</div>
				{options.map((option) => {
					const id = `llamacpp-accel-${option.id}`;
					return (
						<div
							className={
								option.available
									? "flex items-start gap-2.5"
									: "flex items-start gap-2.5 opacity-60"
							}
							key={option.id}
						>
							<RadioGroupItem
								className="mt-0.5"
								disabled={!option.available}
								id={id}
								value={option.id}
							/>
							<div className="flex flex-col gap-0.5">
								<Label htmlFor={id} variant="choice">
									{option.label}
								</Label>
								<p className="text-muted-foreground text-xs">
									{option.available
										? option.description
										: option.unavailableReason}
								</p>
							</div>
						</div>
					);
				})}
			</RadioGroup>
			{switching && (
				<p className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Downloading and switching the build…
				</p>
			)}
			{error && <EngineFootnote tone="destructive">{error}</EngineFootnote>}
		</ListingSection>
	);
}
