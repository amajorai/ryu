import {
	ComposerMenu,
	type ComposerMenuGroup,
	type ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo } from "react";
import type {
	SlashCommand,
	SlashCommandMenuState,
	SlashCommandOptionSelection,
} from "@/src/lib/slash-commands.ts";

export type { SlashCommand } from "@/src/lib/slash-commands.ts";

type SlashCommandAutocompleteProps =
	| {
			anchorRef: React.RefObject<HTMLElement | null>;
			commands: SlashCommand[];
			menu: Extract<SlashCommandMenuState, { kind: "commands" }>;
			onDismiss: () => void;
			onSelect: (command: SlashCommand) => void;
			mode: "commands";
	  }
	| {
			anchorRef: React.RefObject<HTMLElement | null>;
			menu: Extract<SlashCommandMenuState, { kind: "arguments" }>;
			onDismiss: () => void;
			onSelectArgument: (selection: SlashCommandOptionSelection) => void;
			mode: "arguments";
	  };

/** The / trigger expressed through the same list surface as + and @. */
export function SlashCommandAutocomplete({
	...props
}: SlashCommandAutocompleteProps) {
	if (props.mode === "arguments") {
		return <SlashArgumentAutocomplete {...props} />;
	}
	return <SlashCommandList {...props} />;
}

function SlashCommandList({
	anchorRef,
	commands,
	menu,
	onDismiss,
	onSelect,
}: Extract<SlashCommandAutocompleteProps, { mode: "commands" }>) {
	const byId = useMemo(
		() => new Map(commands.map((command) => [command.name, command])),
		[commands]
	);
	const groups = useMemo<ComposerMenuGroup[]>(() => {
		const toItems = (entries: SlashCommand[]) =>
			entries.map((command) => ({
				id: command.name,
				label: `/${command.name}`,
				description: command.description,
				keywords: [command.name, command.hint ?? ""],
				badge:
					command.source === "local"
						? "Ryu"
						: command.source === "plugin"
							? "Plugin"
							: command.source === "skill"
								? "Skill"
								: undefined,
			}));
		const commandEntries = commands.filter(
			(command) => command.source !== "skill"
		);
		const skillEntries = commands.filter(
			(command) => command.source === "skill"
		);
		return [
			{
				id: "commands",
				label: "Commands",
				items: toItems(commandEntries),
			},
			...(skillEntries.length > 0
				? [
						{
							id: "skills",
							label: "Skills",
							items: toItems(skillEntries),
						},
					]
				: []),
		];
	}, [commands]);

	return (
		<ComposerMenu
			anchorRef={anchorRef}
			className="absolute start-0 bottom-full z-50 mb-2"
			groups={groups}
			onDismiss={onDismiss}
			onSelect={(item) => {
				const command = byId.get(item.id);
				if (command) {
					onSelect(command);
				}
			}}
			query={menu.query}
		/>
	);
}

function SlashArgumentAutocomplete({
	anchorRef,
	menu,
	onDismiss,
	onSelectArgument,
}: Extract<SlashCommandAutocompleteProps, { mode: "arguments" }>) {
	const tl = useLiteralMessages();
	const selections = useMemo<Map<string, SlashCommandOptionSelection>>(() => {
		const entries: [string, SlashCommandOptionSelection][] =
			menu.argument.options.map((option, index) => [
				`option:${index}`,
				{ kind: "registered", option },
			]);
		if (menu.argument.custom) {
			const customValue = menu.query.trim();
			entries.push([
				"custom",
				{
					kind: "custom",
					option: {
						description: menu.argument.custom.description,
						label: customValue
							? tl('Use "{customValue}"', { customValue })
							: menu.argument.custom.label,
						value: customValue,
					},
				},
			]);
		}
		return new Map(entries);
	}, [menu.argument.custom, menu.argument.options, menu.query, tl]);
	const groups = useMemo<ComposerMenuGroup[]>(() => {
		const items: ComposerMenuItem[] = menu.argument.options.map(
			(option, index) => ({
				description: option.description ?? menu.argument.description,
				id: `option:${index}`,
				keywords: [option.value],
				label: option.label,
			})
		);
		if (menu.argument.custom) {
			const customValue = menu.query.trim();
			items.push({
				description: menu.argument.custom.description,
				disabled: customValue.length === 0,
				id: "custom",
				keywords: customValue ? [customValue] : [],
				label: customValue
					? tl('Use "{customValue}"', { customValue })
					: menu.argument.custom.label,
			});
		}
		return [
			{
				id: `arguments:${menu.command.name}:${menu.argumentIndex}`,
				items,
				label: tl("Next: {name}", { name: menu.argument.name }),
			},
		];
	}, [menu, tl]);

	return (
		<ComposerMenu
			anchorRef={anchorRef}
			className="absolute start-0 bottom-full z-50 mb-2"
			groups={groups}
			onDismiss={onDismiss}
			onSelect={(item) => {
				const selection = selections.get(item.id);
				if (selection) {
					onSelectArgument(selection);
				}
			}}
			query={menu.query}
		/>
	);
}
