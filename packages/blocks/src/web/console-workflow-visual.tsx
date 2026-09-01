"use client";

import { useState } from "react";
import HeroWorkflowLoop, {
	HeroUseCaseSwitcher,
} from "./hero-workflow-loop.tsx";

/** The same interactive workflow stage used by the homepage, sized for a product hero. */
export function ConsoleWorkflowVisual() {
	const [scenarioIndex, setScenarioIndex] = useState(0);

	return (
		<div className="w-full min-w-0" data-testid="console-workflow-visual">
			<HeroUseCaseSwitcher current={scenarioIndex} onPick={setScenarioIndex} />
			<div className="relative mt-4 flex min-h-[28rem] items-center justify-center overflow-hidden rounded-2xl bg-muted/30 px-4 py-6 md:min-h-[34rem] md:px-8 md:py-10">
				<HeroWorkflowLoop
					onScenarioChange={setScenarioIndex}
					scenarioIndex={scenarioIndex}
				/>
			</div>
		</div>
	);
}
