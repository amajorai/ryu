/**
 * Round 37 and later word senses, kept beside `en-messages-senses.ts` (which merges
 * them into `EN_SENSE_MESSAGES` and `OFFICIAL_SENSE_MESSAGES`) so neither file
 * outgrows the source limits. Same contract: the English stays exactly as
 * written, ids stay stable, and no translation repeats the English word.
 *
 * - `context.freeTokens`: the context window's remaining room; the bare
 *   "Free" is the price (ja "無料").
 * - `heatmap.less` / `heatmap.more`: a heatmap legend's intensity ends; the
 *   bare words are show-less and overflow toggles (ja "閉じる", "その他").
 * - `editor.hyperlink`: a hyperlink or image link noun; the bare "Link" is
 *   the account-linking verb (fr "Associer").
 * - `quiz.hostRole`: the game-show host; the bare "Host" is hosting
 *   (de "Hosten").
 * - `crm.activityNote`: a CRM timeline note; the bare "Note" is also an
 *   annotation (zh-CN "批注").
 *
 * Round 39:
 *
 * - `tuition.subjectsTab`: Tuition's school subjects; the bare "Subjects" is
 *   the abuse-report parties (ja "対象", de "Subjekte").
 * - `workflows.codeScript`: the Workflows code node; the bare "Script" is a
 *   film or video script (ja "台本", es "Guion").
 * - `clips.captionStyleClean` / `videoStudio.cleanLook`: an understated
 *   caption style and a neutral color look; the bare "Clean" is a
 *   reconciliation result (de "Ohne Abweichungen").
 *
 * Round 40:
 *
 * - `kb.guideKind`: the chip on a guide article (knowledge base, product
 *   pages' related reading); the bare "Guide" is the verb (ja "指示",
 *   de "Anleiten").
 * - `projects.internalClient`: Projects' in-house client, shown for a project
 *   saved without one; the bare "Internal" is the confidentiality label
 *   (ja "社外秘").
 *
 * Round 41:
 *
 * - `computeShare.availabilityWindow`: when a shared node is offered (idle or
 *   scheduled hours); the bare "Availability" is a product's availability
 *   status (ja "提供状況").
 * - `flow.connectionHandle`: a flow node's connection point; the bare
 *   "Handle" is a username (de "Benutzername").
 * - `videoStudio.toneHighlights`: the bright tonal range of a color grade;
 *   the bare "Highlights" is the best-moments panel (fr "Temps forts").
 *
 * Systemic round 1:
 *
 * - `clips.windowSources`: the app windows a recording can capture; the bare
 *   "Windows" is the operating system and stays a brand name.
 */
export const EN_SENSE_MESSAGES_MORE = {
	"clips.captionStyleClean": "Clean",
	"clips.windowSources": "Windows",
	"computeShare.availabilityWindow": "Availability",
	"context.freeTokens": "Free",
	"crm.activityNote": "Note",
	"editor.hyperlink": "Link",
	"flow.connectionHandle": "Handle",
	"heatmap.less": "Less",
	"heatmap.more": "More",
	"kb.guideKind": "Guide",
	"projects.internalClient": "Internal",
	"quiz.hostRole": "Host",
	"tuition.subjectsTab": "Subjects",
	"videoStudio.cleanLook": "Clean",
	"videoStudio.toneHighlights": "Highlights",
	"workflows.codeScript": "Script",
} as const;

type MoreSenseMessages = Readonly<
	Record<keyof typeof EN_SENSE_MESSAGES_MORE, string>
>;

/** Each round 37 and later sense in each official pack locale. */
export const OFFICIAL_SENSE_MESSAGES_MORE: Readonly<
	Record<string, MoreSenseMessages>
> = {
	ar: {
		"clips.captionStyleClean": "بسيط",
		"clips.windowSources": "النوافذ",
		"computeShare.availabilityWindow": "أوقات التوفر",
		"context.freeTokens": "متاح",
		"crm.activityNote": "ملاحظة",
		"editor.hyperlink": "رابط",
		"flow.connectionHandle": "نقطة الاتصال",
		"heatmap.less": "أقل",
		"heatmap.more": "أكثر",
		"kb.guideKind": "دليل",
		"projects.internalClient": "داخلي",
		"quiz.hostRole": "المقدّم",
		"tuition.subjectsTab": "المواد",
		"videoStudio.cleanLook": "نقي",
		"videoStudio.toneHighlights": "الإضاءات",
		"workflows.codeScript": "برنامج نصي",
	},
	de: {
		"clips.captionStyleClean": "Schlicht",
		"clips.windowSources": "Fenster",
		"computeShare.availabilityWindow": "Verfügbarkeitszeiten",
		"context.freeTokens": "Frei",
		"crm.activityNote": "Notiz",
		"editor.hyperlink": "Hyperlink",
		"flow.connectionHandle": "Verbindungspunkt",
		"heatmap.less": "Weniger",
		"heatmap.more": "Mehr",
		"kb.guideKind": "Anleitung",
		"projects.internalClient": "Intern",
		"quiz.hostRole": "Moderator",
		"tuition.subjectsTab": "Fächer",
		"videoStudio.cleanLook": "Klar",
		"videoStudio.toneHighlights": "Lichter",
		"workflows.codeScript": "Skript",
	},
	es: {
		"clips.captionStyleClean": "Limpio",
		"clips.windowSources": "Ventanas",
		"computeShare.availabilityWindow": "Horario de disponibilidad",
		"context.freeTokens": "Libre",
		"crm.activityNote": "Nota",
		"editor.hyperlink": "Enlace",
		"flow.connectionHandle": "Punto de conexión",
		"heatmap.less": "Menos",
		"heatmap.more": "Más",
		"kb.guideKind": "Guía",
		"projects.internalClient": "Interno",
		"quiz.hostRole": "Presentador",
		"tuition.subjectsTab": "Asignaturas",
		"videoStudio.cleanLook": "Limpio",
		"videoStudio.toneHighlights": "Iluminaciones",
		"workflows.codeScript": "Script de código",
	},
	fr: {
		"clips.captionStyleClean": "Épuré",
		"clips.windowSources": "Fenêtres",
		"computeShare.availabilityWindow": "Plage de disponibilité",
		"context.freeTokens": "Libre",
		"crm.activityNote": "Remarque",
		"editor.hyperlink": "Lien",
		"flow.connectionHandle": "Point de connexion",
		"heatmap.less": "Moins",
		"heatmap.more": "Plus",
		"kb.guideKind": "Guide pratique",
		"projects.internalClient": "Interne",
		"quiz.hostRole": "Présentateur",
		"tuition.subjectsTab": "Matières",
		"videoStudio.cleanLook": "Net",
		"videoStudio.toneHighlights": "Hautes lumières",
		"workflows.codeScript": "Script de code",
	},
	hi: {
		"clips.captionStyleClean": "सादा",
		"clips.windowSources": "विंडो",
		"computeShare.availabilityWindow": "उपलब्धता का समय",
		"context.freeTokens": "शेष",
		"crm.activityNote": "नोट",
		"editor.hyperlink": "लिंक",
		"flow.connectionHandle": "कनेक्शन बिंदु",
		"heatmap.less": "कम",
		"heatmap.more": "अधिक",
		"kb.guideKind": "गाइड",
		"projects.internalClient": "आंतरिक",
		"quiz.hostRole": "संचालक",
		"tuition.subjectsTab": "विषय",
		"videoStudio.cleanLook": "स्वच्छ",
		"videoStudio.toneHighlights": "हाइलाइट्स",
		"workflows.codeScript": "स्क्रिप्ट",
	},
	it: {
		"clips.captionStyleClean": "Pulito",
		"clips.windowSources": "Finestre",
		"computeShare.availabilityWindow": "Fascia di disponibilità",
		"context.freeTokens": "Libero",
		"crm.activityNote": "Nota",
		"editor.hyperlink": "Collegamento",
		"flow.connectionHandle": "Punto di connessione",
		"heatmap.less": "Meno",
		"heatmap.more": "Più",
		"kb.guideKind": "Guida",
		"projects.internalClient": "Interno",
		"quiz.hostRole": "Conduttore",
		"tuition.subjectsTab": "Materie",
		"videoStudio.cleanLook": "Pulito",
		"videoStudio.toneHighlights": "Alte luci",
		"workflows.codeScript": "Script di codice",
	},
	ja: {
		"clips.captionStyleClean": "シンプル",
		"clips.windowSources": "ウィンドウ",
		"computeShare.availabilityWindow": "提供可能時間",
		"context.freeTokens": "空き",
		"crm.activityNote": "メモ",
		"editor.hyperlink": "リンク",
		"flow.connectionHandle": "接続ハンドル",
		"heatmap.less": "少",
		"heatmap.more": "多",
		"kb.guideKind": "ガイド",
		"projects.internalClient": "社内",
		"quiz.hostRole": "司会",
		"tuition.subjectsTab": "科目",
		"videoStudio.cleanLook": "クリーン",
		"videoStudio.toneHighlights": "ハイライト",
		"workflows.codeScript": "スクリプト",
	},
	ko: {
		"clips.captionStyleClean": "깔끔",
		"clips.windowSources": "창",
		"computeShare.availabilityWindow": "제공 가능 시간",
		"context.freeTokens": "여유",
		"crm.activityNote": "메모",
		"editor.hyperlink": "링크",
		"flow.connectionHandle": "연결 핸들",
		"heatmap.less": "적음",
		"heatmap.more": "많음",
		"kb.guideKind": "가이드",
		"projects.internalClient": "사내",
		"quiz.hostRole": "진행자",
		"tuition.subjectsTab": "과목",
		"videoStudio.cleanLook": "클린",
		"videoStudio.toneHighlights": "밝은 영역",
		"workflows.codeScript": "스크립트",
	},
	pl: {
		"clips.captionStyleClean": "Prosty",
		"clips.windowSources": "Okna",
		"computeShare.availabilityWindow": "Godziny dostępności",
		"context.freeTokens": "Wolne",
		"crm.activityNote": "Notatka",
		"editor.hyperlink": "Hiperłącze",
		"flow.connectionHandle": "Punkt połączenia",
		"heatmap.less": "Mniej",
		"heatmap.more": "Więcej",
		"kb.guideKind": "Poradnik",
		"projects.internalClient": "Wewnętrzny",
		"quiz.hostRole": "Prowadzący",
		"tuition.subjectsTab": "Przedmioty",
		"videoStudio.cleanLook": "Czysty",
		"videoStudio.toneHighlights": "Światła",
		"workflows.codeScript": "Skrypt",
	},
	"pt-BR": {
		"clips.captionStyleClean": "Limpo",
		"clips.windowSources": "Janelas",
		"computeShare.availabilityWindow": "Horário de disponibilidade",
		"context.freeTokens": "Livre",
		"crm.activityNote": "Nota",
		"editor.hyperlink": "Hiperlink",
		"flow.connectionHandle": "Ponto de conexão",
		"heatmap.less": "Menos",
		"heatmap.more": "Mais",
		"kb.guideKind": "Guia",
		"projects.internalClient": "Interno",
		"quiz.hostRole": "Apresentador",
		"tuition.subjectsTab": "Matérias",
		"videoStudio.cleanLook": "Limpo",
		"videoStudio.toneHighlights": "Realces",
		"workflows.codeScript": "Script de código",
	},
	ru: {
		"clips.captionStyleClean": "Чистый",
		"clips.windowSources": "Окна",
		"computeShare.availabilityWindow": "Время доступности",
		"context.freeTokens": "Свободно",
		"crm.activityNote": "Заметка",
		"editor.hyperlink": "Ссылка",
		"flow.connectionHandle": "Точка соединения",
		"heatmap.less": "Меньше",
		"heatmap.more": "Больше",
		"kb.guideKind": "Руководство",
		"projects.internalClient": "Внутренний",
		"quiz.hostRole": "Ведущий",
		"tuition.subjectsTab": "Предметы",
		"videoStudio.cleanLook": "Чистый",
		"videoStudio.toneHighlights": "Света",
		"workflows.codeScript": "Скрипт",
	},
	"zh-CN": {
		"clips.captionStyleClean": "简洁",
		"clips.windowSources": "窗口",
		"computeShare.availabilityWindow": "可用时间",
		"context.freeTokens": "剩余",
		"crm.activityNote": "备注",
		"editor.hyperlink": "链接",
		"flow.connectionHandle": "连接点",
		"heatmap.less": "少",
		"heatmap.more": "多",
		"kb.guideKind": "指南",
		"projects.internalClient": "内部",
		"quiz.hostRole": "主持人",
		"tuition.subjectsTab": "科目",
		"videoStudio.cleanLook": "清爽",
		"videoStudio.toneHighlights": "高光",
		"workflows.codeScript": "脚本",
	},
};
