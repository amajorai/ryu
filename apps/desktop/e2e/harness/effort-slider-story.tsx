import proofStyles from "./effort-slider-story.module.css";
// Standalone browser story for the REAL `EffortSliderRow` — the composer picker's
// reasoning-effort control — mounted INSIDE a real `DropdownMenuContent`.
//
// The nesting is the whole point. A slider is a drag-and-arrow-key control living
// inside a menu that owns arrow keys for row navigation and closes on outward
// pointer activity, and no amount of typechecking says whether the two can coexist.
// This covers exactly that: that the track drags, that Arrow keys move the VALUE
// and not the menu highlight, and that picking a level leaves the menu open so a
// user can adjust again without re-opening.
//
// The second story row carries a THREE-level scale, because the detent count is
// supposed to follow whatever the source advertises — Pi ships `off … max`, other
// agents ship fewer — and a hardcoded ladder would pass a five-level test while
// being wrong for everyone else.
//
// HARNESS LIMIT: this asserts structure and interaction. The bounce/spring motion
// is Motion's, not ours, and is not what these tests are about.

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerSettingsSection } from "../../components/agent-elements/input/composer-settings-menu.tsx";
import { EffortSliderRow } from "../../components/agent-elements/input/effort-slider-row.tsx";
import "../../src/index.css";

const PI_LEVELS = ["off", "low", "medium", "high", "max"];
const SHORT_LEVELS = ["low", "medium", "high"];
// A count the four-stop fill ramp does NOT divide evenly, so its middle detents
// land between stops and take the interpolating branch of `effortFillColor`.
// Pi's five and the three above both land on whole stops and would never reach
// it — an invalid mix there drops the fill's colour entirely.
const OFF_RAMP_LEVELS = ["off", "low", "medium", "high"];

function titled(level: string) {
	return level.charAt(0).toUpperCase() + level.slice(1);
}

function Scale({
	label,
	levels,
	initial,
	testId,
}: {
	initial: string;
	label: string;
	levels: string[];
	testId: string;
}) {
	const [value, setValue] = useState(initial);
	const section: ComposerSettingsSection = {
		key: label,
		label,
		ariaLabel: label,
		items: levels.map((level) => ({ id: level, name: titled(level) })),
		value,
		onChange: setValue,
		variant: "slider",
	};
	return (
		<div data-testid={testId}>
			<EffortSliderRow onSelect={setValue} section={section} />
			{/* The committed value, read back by the spec — the visible caption is a
			    rendering of it, this is the state that actually changed. */}
			<span data-testid={`${testId}-value`}>{value}</span>
		</div>
	);
}

function Story() {
	return (
		<div className={proofStyles.fixture1}>
			<DropdownMenu>
				<DropdownMenuTrigger>Agent</DropdownMenuTrigger>
				<DropdownMenuContent className="w-72">
					<Scale
						initial="medium"
						label="Thinking"
						levels={PI_LEVELS}
						testId="five"
					/>
					<Scale
						initial="low"
						label="Reasoning effort"
						levels={SHORT_LEVELS}
						testId="three"
					/>
					<Scale
						initial="medium"
						label="Depth"
						levels={OFF_RAMP_LEVELS}
						testId="four"
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
