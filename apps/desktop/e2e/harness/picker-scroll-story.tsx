// Standalone browser story for the REAL agent-picker container — the composer's
// `ComposerSettingsMenu` opened upward from a bottom-anchored composer, holding a
// long list of agent rows.
//
// The question this exists to answer is whether that list SCROLLS. On paper it
// must: the shared menu popup carries `max-h-(--available-height)` plus
// `overflow-y-auto`, and Base UI's positioner sets `--available-height` from the
// space between the trigger and the viewport edge. But "on paper" is exactly the
// reading that cannot distinguish a popup that caps and scrolls from one that
// runs off the top of the window — the var could be unset, the cap could be
// overridden by a wrapper, or the body could establish its own scroll container
// and swallow the wheel. Only a real layout resolves it.
//
// The trigger is pinned to the bottom of the viewport on purpose: that is where
// the composer lives, and it is what makes the menu open upward (`side="top"`),
// which is the case the user reports.
//
// HARNESS LIMIT: this asserts geometry (does the popup cap, does it overflow its
// own box). It does not assert that a wheel gesture feels right.

import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AcpOptionPicker } from "../../components/agent-elements/input/acp-pickers.tsx";
import { ComposerSettingsMenu } from "../../components/agent-elements/input/composer-settings-menu.tsx";
import "../../src/index.css";

/** Enough rows that the list cannot fit any plausible viewport. */
const AGENT_COUNT = 60;

/**
 * A `category:"model"` config option the size opencode really advertises. This is
 * the list the user cannot scroll: an ACP agent's own option roster, rendered by
 * `AcpOptionPicker` into the shared composer popover.
 */
const ACP_MODEL_OPTION = {
	id: "model",
	name: "Model",
	category: "model",
	type: "select" as const,
	currentValue: "opencode/big-pickle",
	options: Array.from({ length: 36 }, (_, i) => ({
		value: `provider/model-${i}`,
		name: `Provider ${i} / Model ${i}`,
	})),
};

function Story() {
	const [picked, setPicked] = useState<string | null>(null);

	return (
		<div className="flex h-screen flex-col justify-end bg-background p-3">
			<div data-testid="picked">{picked ?? "none"}</div>
			<div className="flex items-center gap-2">
				<ComposerSettingsMenu
					align="start"
					renderBody={(close) => (
						// The real picker's rows are submenu TRIGGERS, not plain items:
						// every agent opens a sub-popover carrying its model/approval
						// pickers (`TargetSub` in universal-picker-body). Base UI treats a
						// submenu trigger as a highlightable, hover-activated item, so the
						// list under test has to be built from the same primitive — a list
						// of inert buttons would prove nothing about the surface the user
						// is actually scrolling.
						<div className="flex flex-col" data-testid="picker-body">
							{Array.from({ length: AGENT_COUNT }, (_, i) => (
								<DropdownMenuSub key={`agent-${i}`}>
									<DropdownMenuSubTrigger data-testid={`agent-row-${i}`}>
										<span className="flex min-w-0 flex-1 items-center gap-2">
											<span className="truncate">Agent {i}</span>
										</span>
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent className="max-h-96 min-w-[220px] max-w-[320px] overflow-y-auto">
										<DropdownMenuItem
											closeOnClick={false}
											onClick={() => {
												setPicked(`agent-${i}`);
												close();
											}}
										>
											Use Agent {i}
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
							))}
						</div>
					)}
					sections={[]}
					side="top"
					trigger={
						<button data-testid="picker-trigger" type="button">
							Agent · Model
						</button>
					}
				/>
				<AcpOptionPicker
					onChange={setPicked}
					option={ACP_MODEL_OPTION}
					value={ACP_MODEL_OPTION.currentValue}
				/>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
