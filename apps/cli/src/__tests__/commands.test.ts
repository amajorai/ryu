import { expect, test } from "bun:test";
import { LOCAL_SLASH_COMMANDS } from "../core/autocomplete.ts";
import {
	COMMAND_REGISTRY,
	COMMAND_SPECS,
	commandHelpRows,
	dispatchCommand,
	isAdvertisedAgentCommand,
	parseCommand,
	renderCommandHelp,
	resolveCommand,
} from "../core/commands.ts";

test("keeps canonical command specs and autocomplete on one source", () => {
	expect(COMMAND_REGISTRY).toBe(COMMAND_SPECS);
	expect(LOCAL_SLASH_COMMANDS.map((command) => command.name)).toEqual(
		COMMAND_SPECS.filter((command) => command.completion === "command").map(
			(command) => command.name
		)
	);
	expect(resolveCommand("/double-check")?.name).toBe("check");
	expect(resolveCommand("newchat")?.name).toBe("new");
	expect(resolveCommand("/team")?.name).toBe("group");
	expect(dispatchCommand("/group research")).toMatchObject({
		canonicalName: "group",
		action: { action: "set-team", team: "research" },
	});
	expect(resolveCommand("/ACP")?.mode).toBe("overlay");
});

test("parses aliases and preserves unknown slash commands for a warning", () => {
	const parsed = parseCommand("  /session   ");
	expect(parsed?.canonicalName).toBe("sessions");
	expect(parsed?.argument).toBe("");
	expect(parseCommand("plain message")).toBeNull();

	expect(dispatchCommand("/not-a-command")).toMatchObject({
		invokedAs: "not-a-command",
		kind: "unknown",
		message: "Unknown command: /not-a-command",
	});
});

test("only whole unknown slash commands advertised by the active ACP agent pass through", () => {
	const advertised = [{ name: "acp-review" }];
	expect(isAdvertisedAgentCommand("/acp-review --strict", advertised)).toBe(
		true
	);
	expect(isAdvertisedAgentCommand("/acp-reviewer --strict", advertised)).toBe(
		false
	);
	expect(isAdvertisedAgentCommand("/group team-review", advertised)).toBe(
		false
	);
	expect(isAdvertisedAgentCommand("plain chat text", advertised)).toBe(false);
});

test("returns pure intents for local, overlay, and pass-through commands", () => {
	expect(dispatchCommand("/queue clear")).toMatchObject({
		action: { action: "clear-queue", kind: "local" },
		kind: "handled",
		mode: "local",
	});
	expect(dispatchCommand("/sessions")).toMatchObject({
		action: { kind: "overlay", overlay: "session-list" },
		kind: "handled",
		mode: "overlay",
	});
	expect(dispatchCommand("/goal verify the result")).toMatchObject({
		action: {
			kind: "passthrough",
			text: "/goal verify the result",
		},
		kind: "handled",
		mode: "passthrough",
	});
	expect(dispatchCommand("/btw")).toMatchObject({
		kind: "usage",
		usage: "/btw <question>",
	});
	expect(dispatchCommand("/model clear")).toMatchObject({
		action: { action: "set-model", kind: "local", model: null },
		kind: "handled",
		mode: "local",
	});
});

test("derives help rows and help text from the registry", () => {
	const rows = commandHelpRows();
	expect(rows.find((row) => row.name === "queue")).toMatchObject({
		mode: "overlay",
		usage: "/queue [list|clear|drop <id>|up <id>|down <id>]",
	});
	const help = renderCommandHelp();
	expect(help).toContain("/help [command]");
	expect(help).toContain("/queue [list|clear|drop <id>|up <id>|down <id>]");
	expect(help).toContain("/b");
	expect(help).toContain("choose ACP settings");
});

test("takesArguments agrees with each usage line and gates run-on-Enter", () => {
	for (const spec of COMMAND_SPECS) {
		expect({ name: spec.name, takesArguments: spec.takesArguments }).toEqual({
			name: spec.name,
			takesArguments: /[<[]/.test(spec.usage),
		});
	}
	expect(resolveCommand("new")?.takesArguments).toBe(false);
	expect(resolveCommand("model")?.takesArguments).toBe(true);
});
