// The glyph that stands for an interface in the switcher button and menu.
// Specific renderers get their own; the 3D games share a controller, and
// anything else falls back to a layout tile.

import {
	Airplane01Icon,
	Analytics01Icon,
	Book02Icon,
	BookOpen01Icon,
	Building03Icon,
	Calendar03Icon,
	Car01Icon,
	Chat01Icon,
	ChefHatIcon,
	Clock01Icon,
	CommandLineIcon,
	ComputerIcon,
	DashboardSquare01Icon,
	DeliveryTruck01Icon,
	FishFoodIcon,
	GameController03Icon,
	Globe02Icon,
	HierarchySquare01Icon,
	Image01Icon,
	InboxIcon,
	KanbanIcon,
	Mail01Icon,
	Message01Icon,
	News01Icon,
	Note01Icon,
	Package01Icon,
	Passport01Icon,
	Plant01Icon,
	QuestionIcon,
	Settings02Icon,
	Share08Icon,
	Store01Icon,
	Table01Icon,
	Ticket01Icon,
	Tv01Icon,
	UserGroupIcon,
	Wallet01Icon,
} from "@hugeicons/core-free-icons";
import {
	type InterfaceRenderer,
	KIT_GAME_RENDERERS,
} from "@ryuhq/protocol/interfaces";

type IconSvg = typeof DashboardSquare01Icon;

const RENDERER_ICONS: Partial<Record<InterfaceRenderer, IconSvg>> = {
	aquarium: FishFoodIcon,
	bank: Wallet01Icon,
	board: KanbanIcon,
	bot: Chat01Icon,
	calendar: Calendar03Icon,
	canvas: DashboardSquare01Icon,
	channels: Message01Icon,
	cinema: Tv01Icon,
	console: Settings02Icon,
	dashboard: Analytics01Icon,
	departures: Airplane01Icon,
	farm: Plant01Icon,
	feed: News01Icon,
	gallery: Image01Icon,
	graph: Share08Icon,
	inbox: InboxIcon,
	journal: BookOpen01Icon,
	kitchen: ChefHatIcon,
	knowledge: HierarchySquare01Icon,
	library: Book02Icon,
	mail: Mail01Icon,
	market: Store01Icon,
	messenger: Message01Icon,
	newspaper: News01Icon,
	notebook: Note01Icon,
	os: ComputerIcon,
	passport: Passport01Icon,
	qa: QuestionIcon,
	rides: Car01Icon,
	sheet: Table01Icon,
	terminal: CommandLineIcon,
	tickets: Ticket01Icon,
	timeline: Clock01Icon,
	town: Building03Icon,
	tracking: DeliveryTruck01Icon,
	warehouse: Package01Icon,
	workers: UserGroupIcon,
	"world-2d": Globe02Icon,
	"world-3d": Globe02Icon,
};

export function interfaceIcon(renderer: InterfaceRenderer): IconSvg {
	return (
		RENDERER_ICONS[renderer] ??
		(KIT_GAME_RENDERERS.includes(renderer)
			? GameController03Icon
			: DashboardSquare01Icon)
	);
}
