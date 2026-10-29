import {
	RyuAppMain,
	RyuAppSection,
	RyuAppShell,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui.tsx";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerPopover,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./color-picker-proof.css";

const PROOF_SWATCHES = [
	"#000000",
	"#ffffff",
	"#ff3b30",
	"#f0f0f0",
	"#e5e5e5",
	"#d0d0d0",
	"rgba(0, 0, 0, 0.5)",
];

function AppearanceColorControl({
	label,
	value,
	onChange,
}: {
	label: string;
	onChange: (value: string) => void;
	value: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<span className="w-24 shrink-0 text-muted-foreground text-xs">
				{label}
			</span>
			<ColorPicker
				defaultOpen={label === "Accent"}
				onValueChange={onChange}
				swatches={PROOF_SWATCHES}
				value={value}
			>
				<ColorPickerTrigger
					appearance="hex-control"
					aria-label={`${label} color`}
					className="min-w-0 flex-1"
					palette={{ fillHex: value, foregroundHex: "#ffffff" }}
				>
					{value}
				</ColorPickerTrigger>
				<ColorPickerContent>
					<ColorPickerPanel />
				</ColorPickerContent>
			</ColorPicker>
		</div>
	);
}

function ColorPickerProof() {
	const [accent, setAccent] = useState("#0099ff");
	const [surface, setSurface] = useState("#7c5cff");

	return (
		<RyuAppShell surface="standard">
			<RyuAppToolbar
				actions={
					<span className="text-muted-foreground text-xs">
						Shared Ryu primitive
					</span>
				}
				title="Color picker consistency proof"
			/>
			<RyuAppMain>
				<RyuAppSection title="Fluid color controls">
					<div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
						<div className="space-y-4 rounded-xl border border-border bg-card p-5">
							<div>
								<p className="font-medium text-sm">Appearance trigger style</p>
								<p className="mt-1 text-muted-foreground text-xs">
									The existing full-width value trigger stays intact while the
									picker surface gains shared formats and history.
								</p>
							</div>
							<div className="space-y-3">
								<AppearanceColorControl
									label="Accent"
									onChange={setAccent}
									value={accent}
								/>
								<AppearanceColorControl
									label="Surface"
									onChange={setSurface}
									value={surface}
								/>
							</div>
						</div>
						<div className="space-y-3 rounded-xl border border-border bg-card p-5">
							<div>
								<p className="font-medium text-sm">Compact swatch trigger</p>
								<p className="mt-1 text-muted-foreground text-xs">
									Every editor and Companion color field uses the same popover
									and recent-color strip.
								</p>
							</div>
							<ColorPickerPopover
								onValueChange={setSurface}
								swatches={PROOF_SWATCHES}
								triggerAriaLabel="Compact surface color"
								triggerClassName="w-full justify-start"
								value={surface}
							/>
							<p
								className="text-muted-foreground text-xs"
								data-testid="proof-status"
								data-value={surface}
							>
								Selected: {surface}
							</p>
						</div>
					</div>
				</RyuAppSection>
			</RyuAppMain>
		</RyuAppShell>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ColorPickerProof />);
}
