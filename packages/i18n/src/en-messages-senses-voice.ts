/**
 * Voice Studio word senses, merged by `en-messages-senses.ts` like
 * `en-messages-senses-more.ts`. Voice reads its copy as
 * `t("voice.studio.<key>", {}, "English")`, so an official entry for that
 * exact id translates the control without changing the Voice UI; the bare
 * English falls back to its catalog sense elsewhere.
 *
 * - `voice.studio.settings.voice`: the speaker voice to synthesize with; the
 *   bare "Voice" reads as language in German ("Sprache").
 * - `voice.studio.settings.engine`: the text-to-speech model; the bare
 *   "Speech model" is speech recognition (ja 音声認識モデル).
 * - `voice.studio.advanced.delivery` / `advanced.deliveryAria` /
 *   `stories.instruct`: how a line is read aloud; the bare "Delivery" is
 *   shipping (ja 受け渡し, ru "Доставка").
 * - `voice.studio.stories.addLine` / `stories.lineLabel`: a line of a story
 *   script, matching the sibling "{number} 行目" sentences; the bare "Add
 *   line" and "Line {number}" are phone lines (ja 回線) in Calls.
 * - `voice.studio.stories.create`: a new spoken story; the bare "New story" is
 *   a news article (ja 新しい記事) in the newspaper interface.
 */
export const EN_SENSE_MESSAGES_VOICE = {
	"voice.studio.advanced.delivery": "Delivery",
	"voice.studio.advanced.deliveryAria": "Delivery",
	"voice.studio.settings.engine": "Speech model",
	"voice.studio.settings.voice": "Voice",
	"voice.studio.stories.addLine": "Add line",
	"voice.studio.stories.create": "New story",
	"voice.studio.stories.instruct": "Delivery",
	"voice.studio.stories.lineLabel": "Line {number}",
} as const;

type VoiceSenseMessages = Readonly<
	Record<keyof typeof EN_SENSE_MESSAGES_VOICE, string>
>;

/** Each sense above in each official pack locale. */
export const OFFICIAL_SENSE_MESSAGES_VOICE: Readonly<
	Record<string, VoiceSenseMessages>
> = {
	ar: {
		"voice.studio.advanced.delivery": "أسلوب الأداء",
		"voice.studio.advanced.deliveryAria": "أسلوب الأداء",
		"voice.studio.settings.engine": "نموذج تحويل النص إلى كلام",
		"voice.studio.settings.voice": "الصوت",
		"voice.studio.stories.addLine": "إضافة سطر",
		"voice.studio.stories.create": "قصة جديدة",
		"voice.studio.stories.instruct": "أسلوب الأداء",
		"voice.studio.stories.lineLabel": "السطر {number}",
	},
	de: {
		"voice.studio.advanced.delivery": "Vortragsweise",
		"voice.studio.advanced.deliveryAria": "Vortragsweise",
		"voice.studio.settings.engine": "Sprachsynthesemodell",
		"voice.studio.settings.voice": "Stimme",
		"voice.studio.stories.addLine": "Zeile hinzufügen",
		"voice.studio.stories.create": "Neue Geschichte",
		"voice.studio.stories.instruct": "Vortragsweise",
		"voice.studio.stories.lineLabel": "Zeile {number}",
	},
	es: {
		"voice.studio.advanced.delivery": "Estilo de lectura",
		"voice.studio.advanced.deliveryAria": "Estilo de lectura",
		"voice.studio.settings.engine": "Modelo de síntesis de voz",
		"voice.studio.settings.voice": "Voz",
		"voice.studio.stories.addLine": "Añadir línea",
		"voice.studio.stories.create": "Nueva historia",
		"voice.studio.stories.instruct": "Estilo de lectura",
		"voice.studio.stories.lineLabel": "Línea {number}",
	},
	fr: {
		"voice.studio.advanced.delivery": "Style de lecture",
		"voice.studio.advanced.deliveryAria": "Style de lecture",
		"voice.studio.settings.engine": "Modèle de synthèse vocale",
		"voice.studio.settings.voice": "Voix",
		"voice.studio.stories.addLine": "Ajouter une ligne",
		"voice.studio.stories.create": "Nouvelle histoire",
		"voice.studio.stories.instruct": "Style de lecture",
		"voice.studio.stories.lineLabel": "Ligne {number}",
	},
	hi: {
		"voice.studio.advanced.delivery": "बोलने की शैली",
		"voice.studio.advanced.deliveryAria": "बोलने की शैली",
		"voice.studio.settings.engine": "स्पीच सिंथेसिस मॉडल",
		"voice.studio.settings.voice": "आवाज़",
		"voice.studio.stories.addLine": "पंक्ति जोड़ें",
		"voice.studio.stories.create": "नई कहानी",
		"voice.studio.stories.instruct": "बोलने की शैली",
		"voice.studio.stories.lineLabel": "पंक्ति {number}",
	},
	it: {
		"voice.studio.advanced.delivery": "Stile di lettura",
		"voice.studio.advanced.deliveryAria": "Stile di lettura",
		"voice.studio.settings.engine": "Modello di sintesi vocale",
		"voice.studio.settings.voice": "Voce",
		"voice.studio.stories.addLine": "Aggiungi riga",
		"voice.studio.stories.create": "Nuova storia",
		"voice.studio.stories.instruct": "Stile di lettura",
		"voice.studio.stories.lineLabel": "Riga {number}",
	},
	ja: {
		"voice.studio.advanced.delivery": "読み方のスタイル",
		"voice.studio.advanced.deliveryAria": "読み方のスタイル",
		"voice.studio.settings.engine": "音声合成モデル",
		"voice.studio.settings.voice": "ボイス",
		"voice.studio.stories.addLine": "行を追加",
		"voice.studio.stories.create": "新しいストーリー",
		"voice.studio.stories.instruct": "読み方のスタイル",
		"voice.studio.stories.lineLabel": "{number} 行目",
	},
	ko: {
		"voice.studio.advanced.delivery": "읽기 스타일",
		"voice.studio.advanced.deliveryAria": "읽기 스타일",
		"voice.studio.settings.engine": "음성 합성 모델",
		"voice.studio.settings.voice": "목소리",
		"voice.studio.stories.addLine": "줄 추가",
		"voice.studio.stories.create": "새 스토리",
		"voice.studio.stories.instruct": "읽기 스타일",
		"voice.studio.stories.lineLabel": "{number}번째 줄",
	},
	"pt-BR": {
		"voice.studio.advanced.delivery": "Estilo de leitura",
		"voice.studio.advanced.deliveryAria": "Estilo de leitura",
		"voice.studio.settings.engine": "Modelo de síntese de fala",
		"voice.studio.settings.voice": "Voz",
		"voice.studio.stories.addLine": "Adicionar linha",
		"voice.studio.stories.create": "Nova história",
		"voice.studio.stories.instruct": "Estilo de leitura",
		"voice.studio.stories.lineLabel": "Linha {number}",
	},
	ru: {
		"voice.studio.advanced.delivery": "Манера чтения",
		"voice.studio.advanced.deliveryAria": "Манера чтения",
		"voice.studio.settings.engine": "Модель синтеза речи",
		"voice.studio.settings.voice": "Голос",
		"voice.studio.stories.addLine": "Добавить строку",
		"voice.studio.stories.create": "Новая история",
		"voice.studio.stories.instruct": "Манера чтения",
		"voice.studio.stories.lineLabel": "Строка {number}",
	},
	"zh-CN": {
		"voice.studio.advanced.delivery": "朗读风格",
		"voice.studio.advanced.deliveryAria": "朗读风格",
		"voice.studio.settings.engine": "语音合成模型",
		"voice.studio.settings.voice": "声音",
		"voice.studio.stories.addLine": "添加一行",
		"voice.studio.stories.create": "新建故事",
		"voice.studio.stories.instruct": "朗读风格",
		"voice.studio.stories.lineLabel": "第 {number} 行",
	},
};
