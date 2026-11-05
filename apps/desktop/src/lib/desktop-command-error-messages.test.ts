import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	desktopCommandErrorLine,
	desktopCommandErrorText,
	parseDesktopCommandError,
	terminalErrorLines,
} from "./desktop-command-error-messages.ts";

const GERMAN: Record<string, string> = {
	"This file is too large to annotate here.":
		"Diese Datei ist zu groß, um sie hier zu kommentieren.",
	"This file could not be read.": "Diese Datei konnte nicht gelesen werden.",
	"The working directory {dir} does not exist.":
		"Das Arbeitsverzeichnis {dir} existiert nicht.",
	"{dir} is not a folder.": "{dir} ist kein Ordner.",
	"The command could not be run.": "Der Befehl konnte nicht ausgeführt werden.",
};

const de = ((source: string, values?: Record<string, unknown>) =>
	formatMessage(
		GERMAN[source] ?? source,
		values as Parameters<typeof formatMessage>[1],
		"de"
	)) as LiteralMessage;

describe("parseDesktopCommandError", () => {
	test("splits on the first colon only, so Windows paths survive", () => {
		expect(parseDesktopCommandError("invalid_cwd:C:\\work")).toEqual({
			code: "invalid_cwd",
			detail: "C:\\work",
		});
		expect(parseDesktopCommandError(new Error("file_too_large"))).toEqual({
			code: "file_too_large",
			detail: null,
		});
	});

	test("leaves uncoded text and unknown codes alone", () => {
		expect(parseDesktopCommandError("fatal: not a git repository")).toBeNull();
		expect(parseDesktopCommandError("other_code:x")).toBeNull();
		expect(parseDesktopCommandError({ code: "io" })).toBeNull();
	});
});

describe("desktopCommandErrorText under de", () => {
	test("words each code as one whole German sentence", () => {
		expect(desktopCommandErrorText("file_too_large", de)).toEqual({
			message: "Diese Datei ist zu groß, um sie hier zu kommentieren.",
			detail: null,
		});
		expect(
			desktopCommandErrorText("io:No such file or directory (os error 2)", de)
		).toEqual({
			message: "Diese Datei konnte nicht gelesen werden.",
			detail: "No such file or directory (os error 2)",
		});
		expect(desktopCommandErrorText("invalid_cwd:/gone", de)?.message).toBe(
			"Das Arbeitsverzeichnis /gone existiert nicht."
		);
		expect(desktopCommandErrorText("cwd_not_dir:/a.txt", de)?.message).toBe(
			"/a.txt ist kein Ordner."
		);
		expect(desktopCommandErrorText("invalid_env_name:1X", de)?.message).toBe(
			"Der Befehl konnte nicht ausgeführt werden."
		);
	});

	test("plain-text surfaces pass real tool output through unchanged", () => {
		expect(desktopCommandErrorLine("fatal: bad revision", de)).toBe(
			"fatal: bad revision"
		);
		expect(desktopCommandErrorLine("invalid_cwd:/gone", de)).toBe(
			"Das Arbeitsverzeichnis /gone existiert nicht."
		);
	});

	test("the terminal shows the sentence, then the raw spawn cause", () => {
		expect(terminalErrorLines("spawn_failed:program not found", de)).toEqual([
			{ type: "error", text: "Der Befehl konnte nicht ausgeführt werden." },
			{ type: "error", text: "program not found" },
		]);
		expect(terminalErrorLines("cwd_not_dir:/a.txt", de)).toEqual([
			{ type: "error", text: "/a.txt ist kein Ordner." },
		]);
	});
});

const JAPANESE_AND_ARABIC: Record<string, Record<string, string>> = {
	ar: { "{dir} is not a folder.": "{dir} ليس مجلدًا." },
	ja: {
		"The working directory {dir} does not exist.":
			"作業ディレクトリ {dir} は存在しません。",
	},
};

function catalogTl(locale: string): LiteralMessage {
	return ((source: string, values?: Record<string, unknown>) =>
		formatMessage(
			JAPANESE_AND_ARABIC[locale]?.[source] ?? source,
			values as Parameters<typeof formatMessage>[1],
			locale
		)) as LiteralMessage;
}

describe("desktopCommandErrorText under ja and ar", () => {
	test("interpolates the folder path into the whole translated sentence", () => {
		expect(
			desktopCommandErrorText("invalid_cwd:C:\\work", catalogTl("ja"))?.message
		).toBe("作業ディレクトリ C:\\work は存在しません。");
		expect(
			desktopCommandErrorText("cwd_not_dir:/a.txt", catalogTl("ar"))?.message
		).toBe("/a.txt ليس مجلدًا.");
	});
});

const GERMAN_SCHEDULE: Record<string, string> = {
	"The time or version for this scheduled update is not valid.":
		"Zeit oder Version dieses geplanten Updates sind ungültig.",
	"Ryu could not find this computer's settings folder, so the update cannot be scheduled.":
		"Ryu konnte den Einstellungsordner dieses Computers nicht finden, daher kann das Update nicht geplant werden.",
	"Ryu could not save the scheduled update. Check that its settings folder can be written to, then try again.":
		"Ryu konnte das geplante Update nicht speichern. Prüfe, ob in den Einstellungsordner geschrieben werden kann, und versuche es dann erneut.",
};

const deSchedule = ((source: string) =>
	GERMAN_SCHEDULE[source] ?? source) as LiteralMessage;

describe("set_pending_app_update rejections under de", () => {
	test("each update-scheduling code is one whole German sentence", () => {
		expect(desktopCommandErrorText("invalid_request", deSchedule)).toEqual({
			message: "Zeit oder Version dieses geplanten Updates sind ungültig.",
			detail: null,
		});
		expect(desktopCommandErrorLine("no_config_dir", deSchedule)).toBe(
			"Ryu konnte den Einstellungsordner dieses Computers nicht finden, daher kann das Update nicht geplant werden."
		);
	});

	test("the OS cause of a failed write stays a secondary detail", () => {
		const coded = desktopCommandErrorText(
			"write_failed:Permission denied (os error 13)",
			deSchedule
		);
		expect(coded).toEqual({
			message:
				"Ryu konnte das geplante Update nicht speichern. Prüfe, ob in den Einstellungsordner geschrieben werden kann, und versuche es dann erneut.",
			detail: "Permission denied (os error 13)",
		});
		expect(
			desktopCommandErrorLine("write_failed:Permission denied", deSchedule)
		).not.toContain("Permission denied");
	});
});
