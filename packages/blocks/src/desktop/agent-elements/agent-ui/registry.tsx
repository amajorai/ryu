// Registry: maps every component in ./catalog.ts to a real `@ryu/ui` (Base UI)
// component, so agent-rendered UI uses the exact same primitives — and therefore
// the same theme tokens, focus behavior and accessibility — as the rest of the app.
//
// Interactive fields use json-render's `useBoundProp(props.x, bindings?.x)` to get
// a [value, setValue] pair wired to the spec's `{ $bindState: "path" }` bindings.

import { type Components, defineRegistry } from "@json-render/react";
import { agentUiCatalog } from "./catalog.ts";
import { ChartRenderer } from "./registry-chart.tsx";
import {
	ApprovalCardRenderer,
	ButtonRenderer,
	CheckboxRenderer,
	InputRenderer,
	LinkPreviewRenderer,
	OptionListRenderer,
	ProgressRenderer,
	SelectRenderer,
	SkeletonRenderer,
	SliderRenderer,
	StatRenderer,
	SwitchRenderer,
	TextareaRenderer,
} from "./registry-controls.tsx";
import {
	AlertRenderer,
	AvatarRenderer,
	BadgeRenderer,
	CardRenderer,
	GridRenderer,
	HeadingRenderer,
	ImageRenderer,
	LinkRenderer,
	SeparatorRenderer,
	StackRenderer,
	TableRenderer,
	TextRenderer,
} from "./registry-display.tsx";

const components = {
	Stack: StackRenderer,
	Grid: GridRenderer,
	Card: CardRenderer,
	Separator: SeparatorRenderer,
	Heading: HeadingRenderer,
	Text: TextRenderer,
	Link: LinkRenderer,
	Image: ImageRenderer,
	Avatar: AvatarRenderer,
	Badge: BadgeRenderer,
	Alert: AlertRenderer,
	Table: TableRenderer,
	Chart: ChartRenderer,
	Stat: StatRenderer,
	Progress: ProgressRenderer,
	Skeleton: SkeletonRenderer,
	Button: ButtonRenderer,
	Input: InputRenderer,
	Textarea: TextareaRenderer,
	Checkbox: CheckboxRenderer,
	Switch: SwitchRenderer,
	Select: SelectRenderer,
	OptionList: OptionListRenderer,
	Slider: SliderRenderer,
	ApprovalCard: ApprovalCardRenderer,
	LinkPreview: LinkPreviewRenderer,
} satisfies Components<typeof agentUiCatalog>;

export const { registry } = defineRegistry(agentUiCatalog, {
	actions: {
		submit: async () => undefined,
	},
	components,
});
