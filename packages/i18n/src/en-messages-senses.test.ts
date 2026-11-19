import { describe, expect, test } from "bun:test";
import { I18nRuntime } from "./core.ts";
import {
	EN_SENSE_MESSAGES,
	OFFICIAL_SENSE_MESSAGES,
	withSenseMessages,
} from "./en-messages-senses.ts";
import { placeholderNames } from "./icu-syntax.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";
import { OFFICIAL_LANGUAGE_PACKS } from "./locales.ts";
import { BUILT_IN_LANGUAGE_PACKS } from "./messages.ts";
import type { LanguagePack } from "./pack.ts";

const ids = Object.keys(EN_SENSE_MESSAGES).sort();

function builtIn(locale: string): LanguagePack {
	const pack = BUILT_IN_LANGUAGE_PACKS.find((entry) => entry.locale === locale);
	if (!pack) {
		throw new Error(`no built-in pack for ${locale}`);
	}
	return pack;
}

describe("sense-keyed messages", () => {
	test("every official pack carries every sense id", () => {
		for (const pack of OFFICIAL_LANGUAGE_PACKS) {
			const senses = OFFICIAL_SENSE_MESSAGES[pack.locale];
			expect(senses && Object.keys(senses).sort()).toEqual(ids);
			for (const id of ids) {
				expect(builtIn(pack.locale).messages[id]?.trim()).toBeTruthy();
			}
		}
	});

	test("translations keep the English placeholders and never repeat English", () => {
		for (const [locale, senses] of Object.entries(OFFICIAL_SENSE_MESSAGES)) {
			for (const [id, value] of Object.entries(senses)) {
				const source = EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES];
				expect(placeholderNames(value)).toEqual(placeholderNames(source));
				// An English value would let the DOM localizer swap in the
				// bare word's other sense.
				expect({ id, locale, value }).not.toEqual({
					id,
					locale,
					value: source,
				});
			}
		}
	});

	test("the English stays the word end-to-end specs select", () => {
		expect(EN_SENSE_MESSAGES).toEqual({
			"agentStats.steps": "Steps",
			"calendar.weekdayPicker": "Day",
			"calls.incoming": "Incoming",
			"cardTable.layoutTable": "Table",
			"clips.captionStyleClean": "Clean",
			"clips.startRecording": "Start recording",
			"clips.stopRecording": "Stop recording",
			"clips.windowSources": "Windows",
			"computeShare.availabilityWindow": "Availability",
			"context.freeTokens": "Free",
			"crm.activityNote": "Note",
			"dataGrid.checked": "Checked",
			"dataGrid.unchecked": "Unchecked",
			"departures.destination": "To",
			"departures.destinationColumn": "Destination",
			"departures.origin": "From",
			"devices.foreground": "Open now",
			"editor.hyperlink": "Link",
			"farm.crop": "Crop",
			"flow.connectionHandle": "Handle",
			"forms.addQuestion": "Add a question",
			"forms.questionBlocks": "Questions",
			"forms.removeQuestion": "Remove question",
			"hardware.deviceDesk": "Desk",
			"hardware.deviceNecklace": "Necklace",
			"hardware.devicePhone": "Phone",
			"hardware.deviceWatch": "Watch",
			"hardware.memory": "Memory",
			"heatmap.less": "Less",
			"heatmap.more": "More",
			"import.created": "Created",
			"import.updated": "Updated",
			"journal.entry": "Entry",
			"kb.guideKind": "Guide",
			"kitchen.orderTickets": "Tickets",
			"lists.item": "Item",
			"lobby.claimReward": "Claim",
			"lobby.play": "Play",
			"mail.recipientTo": "To",
			"missionControl.touchEdit": "edit",
			"missionControl.touchNew": "new",
			"missionControl.touchRead": "read",
			"nav.tableOfContents": "Contents",
			"news.savedTab": "Saved",
			"news.storiesTab": "Stories",
			"places.bookingWhen": "When",
			"places.tripPlanTab": "Plan",
			"plans.paidTier": "Paid",
			"plans.trialTier": "Trial",
			"policies.resolveEffective": "Resolve",
			"profile.unlockPoints": "Points",
			"projects.dueDate": "Due date",
			"projects.internalClient": "Internal",
			"qa.question": "Question",
			"quiz.contestantOut": "Out",
			"quiz.hostRole": "Host",
			"records.noteField": "Note",
			"runs.started": "Started",
			"schedule.rangeFrom": "From",
			"showcase.thisWeek": "this week",
			"social.composePost": "Compose",
			"status.online": "Online",
			"status.open": "Open",
			"threads.readState": "Read",
			"ticker.sortChange": "Change",
			"time.notYet": "Not yet",
			"tools.readDone": "Read",
			"tracking.inTransit": "On the way",
			"tuition.subjectsTab": "Subjects",
			"ugc.postColumn": "Post",
			"usage.lifetime": "Lifetime",
			"videoStudio.cleanLook": "Clean",
			"videoStudio.toneHighlights": "Highlights",
			"view.display": "Display",
			"voice.studio.advanced.delivery": "Delivery",
			"voice.studio.advanced.deliveryAria": "Delivery",
			"voice.studio.settings.engine": "Speech model",
			"voice.studio.settings.voice": "Voice",
			"voice.studio.stories.addLine": "Add line",
			"voice.studio.stories.create": "New story",
			"voice.studio.stories.instruct": "Delivery",
			"voice.studio.stories.lineLabel": "Line {number}",
			"wiki.talkTab": "Talk",
			"workflows.codeScript": "Script",
			"workflows.startRecording": "Start recording",
		});
		// The bare word keeps its literal id, so `tl("Plan")` and DOM text never
		// pick up a surface's sense. A few words already have a named id for
		// their other sense ("Open" the verb, "Free" the price).
		const named: Record<string, string> = {
			Free: "common.free",
			More: "common.more",
			Note: "island.note",
			Open: "login.open",
			Voice: "settings.nav.voice",
		};
		for (const source of Object.values(EN_SENSE_MESSAGES)) {
			const id = messageIdForLiteral(source);
			const expected = named[source];
			expect(expected ? id : id.slice(0, 8)).toBe(expected ?? "literal.");
		}
		const english = new I18nRuntime([], { initialLocale: "en" });
		// Voice's "Line {number}" is the one sense with a placeholder.
		for (const [id, source] of Object.entries(EN_SENSE_MESSAGES)) {
			expect(english.translate(id, { number: 2 })).toBe(
				source.replace("{number}", "2")
			);
		}
	});

	test("a sense id resolves apart from the bare word's literal translation", () => {
		const japanese = new I18nRuntime([], { initialPackId: "official/ja" });
		expect(japanese.translate("mail.recipientTo", {}, "To")).toBe("宛先");
		expect(japanese.translate("calendar.weekdayPicker", {}, "Day")).toBe(
			"曜日"
		);
		expect(japanese.translate("kitchen.orderTickets", {}, "Tickets")).toBe(
			"伝票"
		);
		const german = new I18nRuntime([], { initialPackId: "official/de" });
		expect(german.translate("places.tripPlanTab", {}, "Plan")).toBe(
			"Reiseplan"
		);
		// The billing sense of the bare word is untouched.
		expect(german.translate(messageIdForLiteral("Plan"))).toBe("Tarif");
		const arabic = new I18nRuntime([], { initialPackId: "official/ar" });
		expect(arabic.translate("policies.resolveEffective", {}, "Resolve")).toBe(
			"احتساب"
		);
	});

	test("round 33 senses resolve to their reviewed translations", () => {
		const reviewed: Record<string, Record<string, string>> = {
			ar: {
				"cardTable.layoutTable": "الطاولة",
				"farm.crop": "المحصول",
				"lobby.play": "العب",
				"plans.paidTier": "مدفوع",
				"profile.unlockPoints": "بالنقاط",
				"threads.readState": "مقروءة",
				"ticker.sortChange": "التغير",
				"tools.readDone": "تمت القراءة",
				"ugc.postColumn": "المنشور",
			},
			de: {
				"cardTable.layoutTable": "Spieltisch",
				"farm.crop": "Kultur",
				"lobby.play": "Spielen",
				"plans.paidTier": "Kostenpflichtig",
				"profile.unlockPoints": "Mit Punkten",
				"threads.readState": "Gelesen",
				"ticker.sortChange": "Veränderung",
				"tools.readDone": "Gelesen",
				"ugc.postColumn": "Beitrag",
			},
			ja: {
				"cardTable.layoutTable": "テーブル",
				"farm.crop": "作物",
				"lobby.play": "プレイ",
				"plans.paidTier": "有料",
				"profile.unlockPoints": "ポイント",
				"threads.readState": "既読",
				"ticker.sortChange": "変動",
				"tools.readDone": "読み込み完了",
				"ugc.postColumn": "投稿",
			},
		};
		for (const [locale, senses] of Object.entries(reviewed)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source = EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES];
				expect({ id, value: runtime.translate(id, {}, source) }).toEqual({
					id,
					value,
				});
			}
		}
	});

	test("round 34 senses keep the device and status meanings", () => {
		// The bare "Watch" is the observe verb (de "Beobachten"), "Desk" the help
		// desk (ja "ヘルプデスク") and "Open" the verb (ja "開く").
		const german = new I18nRuntime([], { initialPackId: "official/de" });
		expect(german.translate("hardware.deviceWatch", {}, "Watch")).toBe("Uhr");
		expect(german.translate("hardware.deviceDesk", {}, "Desk")).toBe(
			"Tischdisplay"
		);
		expect(german.translate("status.open", {}, "Open")).toBe("Offen");
		const japanese = new I18nRuntime([], { initialPackId: "official/ja" });
		expect(japanese.translate("hardware.deviceDesk", {}, "Desk")).toBe(
			"デスク"
		);
		expect(japanese.translate("hardware.deviceNecklace", {}, "Necklace")).toBe(
			"ネックレス"
		);
		expect(japanese.translate("status.open", {}, "Open")).toBe("オープン");
	});

	test("round 35 senses keep the tab, range, board and game meanings", () => {
		// The bare "Talk" is the speak verb (ja "話す"), "From" a move source
		// (ja "移動元"), "Out" token output (ja "出力"), "Claim" reserving an
		// alias (de "Beanspruchen") and "Compose" a message (ar "إنشاء رسالة").
		const japanese = new I18nRuntime([], { initialPackId: "official/ja" });
		expect(japanese.translate("wiki.talkTab", {}, "Talk")).toBe("ノート");
		expect(japanese.translate("departures.origin", {}, "From")).toBe("出発地");
		expect(japanese.translate("departures.destination", {}, "To")).toBe(
			"到着地"
		);
		expect(japanese.translate("schedule.rangeFrom", {}, "From")).toBe("開始");
		expect(japanese.translate("quiz.contestantOut", {}, "Out")).toBe("脱落");
		expect(japanese.translate("lobby.claimReward", {}, "Claim")).toBe(
			"受け取る"
		);
		const german = new I18nRuntime([], { initialPackId: "official/de" });
		expect(german.translate("lobby.claimReward", {}, "Claim")).toBe("Abholen");
		expect(german.translate("wiki.talkTab", {}, "Talk")).toBe("Diskussion");
		const arabic = new I18nRuntime([], { initialPackId: "official/ar" });
		expect(arabic.translate("social.composePost", {}, "Compose")).toBe(
			"إنشاء منشور"
		);
		expect(arabic.translate("lobby.claimReward", {}, "Claim")).toBe("استلام");
	});

	test("round 36 senses keep the view, device, status and list meanings", () => {
		// The bare "Display" is a monitor (zh-CN "显示器"), "Steps" a stepped
		// curve (de "Stufen"), "Trial" the agent lifecycle (de "Test"), "Online"
		// an online event (zh-CN "线上"), "Phone" a phone number (ja "電話番号"),
		// "Question" an exam item (ja "問題") and "Item" merchandise (ru "Товар").
		const expected: Record<string, Record<string, string>> = {
			ar: { "status.online": "متصل", "view.display": "العرض" },
			de: {
				"agentStats.steps": "Schritte",
				"lists.item": "Eintrag",
				"plans.trialTier": "Testphase",
				"view.display": "Darstellung",
			},
			ja: {
				"hardware.devicePhone": "スマートフォン",
				"qa.question": "質問",
				"view.display": "表示",
			},
			ko: {
				"hardware.devicePhone": "휴대폰",
				"plans.trialTier": "체험판",
				"qa.question": "질문",
			},
			ru: { "lists.item": "Пункт", "plans.trialTier": "Пробный период" },
			"zh-CN": {
				"hardware.devicePhone": "手机",
				"lists.item": "条目",
				"qa.question": "问题",
				"status.online": "在线",
				"view.display": "显示",
			},
		};
		for (const [locale, senses] of Object.entries(expected)) {
			const runtime = new I18nRuntime([], {
				initialPackId: `official/${locale.toLowerCase()}`,
			});
			for (const [id, value] of Object.entries(senses)) {
				const source = EN_SENSE_MESSAGES[id as keyof typeof EN_SENSE_MESSAGES];
				expect({
					id,
					locale,
					value: runtime.translate(id, {}, source),
				}).toEqual({ id, locale, value });
			}
		}
	});

	test("a pack for a locale without sense terms is returned unchanged", () => {
		const community: LanguagePack = {
			baseLocale: "en",
			direction: "ltr",
			id: "community-xx",
			locale: "xx",
			messages: { "common.edit": "Edit-xx" },
			name: "Example",
			schemaVersion: 1,
			version: "1.0.0",
		};
		expect(withSenseMessages(community)).toBe(community);
	});
});
