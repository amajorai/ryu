/**
 * Word senses from the systemic sense lints (round 42 findings), kept beside
 * `en-messages-senses.ts` (which merges them into `EN_SENSE_MESSAGES` and
 * `OFFICIAL_SENSE_MESSAGES`) so neither file outgrows the source limits. Same
 * contract: the English stays exactly as written, ids stay stable, and no
 * translation repeats the English word.
 *
 * - `usage.lifetime`: an all-time total (usage stats, a budget window with no
 *   reset); the bare "Lifetime" is a one-time purchase (ja 買い切り).
 * - `hardware.memory`: a computer's RAM (download requirements); the bare
 *   "Memory" is agent memory (de Gedächtnis, zh-CN 记忆).
 * - `nav.tableOfContents`: a table-of-contents heading; the bare "Contents"
 *   is what something holds (ja 内容).
 * - `calls.incoming`: an inbound phone call; the bare "Incoming" is the
 *   incoming side of a change (ja 新規, de Neu).
 * - `dataGrid.checked` / `dataGrid.unchecked`: a checkbox column's filter
 *   values; the bare words are a check time (ja チェック日時) and "not
 *   verified" (ja 未確認).
 * - `import.created` / `import.updated`: counts of records an import created
 *   or updated; the bare words are date columns (ja 作成日時, 更新日).
 * - `runs.started`: a run step's status; the bare "Started" is a start-time
 *   column (ja 開始日時).
 * - `departures.destinationColumn`: a departures board's destination column;
 *   the bare "Destination" is a save location (ja 保存先).
 * - `journal.entry`: one journal entry; the bare "Entry" is admission
 *   (ja 入場, de Einlass).
 * - `records.noteField`: a memo field on an invoice or expense; the bare
 *   "Note" is an annotation (zh-CN 批注).
 */
export const EN_SENSE_MESSAGES_SYSTEMIC = {
	"calls.incoming": "Incoming",
	"dataGrid.checked": "Checked",
	"dataGrid.unchecked": "Unchecked",
	"departures.destinationColumn": "Destination",
	"hardware.memory": "Memory",
	"import.created": "Created",
	"import.updated": "Updated",
	"journal.entry": "Entry",
	"nav.tableOfContents": "Contents",
	"records.noteField": "Note",
	"runs.started": "Started",
	"usage.lifetime": "Lifetime",
} as const;

type SystemicSenseMessages = Readonly<
	Record<keyof typeof EN_SENSE_MESSAGES_SYSTEMIC, string>
>;

/** Each systemic-round sense in each official pack locale. */
export const OFFICIAL_SENSE_MESSAGES_SYSTEMIC: Readonly<
	Record<string, SystemicSenseMessages>
> = {
	ar: {
		"calls.incoming": "واردة",
		"dataGrid.checked": "محدد",
		"dataGrid.unchecked": "غير محدد",
		"departures.destinationColumn": "الوجهة",
		"hardware.memory": "الذاكرة العشوائية",
		"import.created": "أُنشئت",
		"import.updated": "حُدّثت",
		"journal.entry": "التدوينة",
		"nav.tableOfContents": "المحتويات",
		"records.noteField": "ملاحظة",
		"runs.started": "بدأ",
		"usage.lifetime": "منذ البداية",
	},
	de: {
		"calls.incoming": "Eingehend",
		"dataGrid.checked": "Aktiviert",
		"dataGrid.unchecked": "Nicht aktiviert",
		"departures.destinationColumn": "Ziel",
		"hardware.memory": "Arbeitsspeicher",
		"import.created": "Erstellt",
		"import.updated": "Aktualisiert",
		"journal.entry": "Eintrag",
		"nav.tableOfContents": "Inhaltsverzeichnis",
		"records.noteField": "Notiz",
		"runs.started": "Gestartet",
		"usage.lifetime": "Gesamt",
	},
	es: {
		"calls.incoming": "Entrante",
		"dataGrid.checked": "Marcado",
		"dataGrid.unchecked": "Sin marcar",
		"departures.destinationColumn": "Destino",
		"hardware.memory": "Memoria RAM",
		"import.created": "Creados",
		"import.updated": "Actualizados",
		"journal.entry": "Entrada",
		"nav.tableOfContents": "Índice",
		"records.noteField": "Nota",
		"runs.started": "Iniciado",
		"usage.lifetime": "Acumulado",
	},
	fr: {
		"calls.incoming": "Entrant",
		"dataGrid.checked": "Coché",
		"dataGrid.unchecked": "Non coché",
		"departures.destinationColumn": "Vers",
		"hardware.memory": "Mémoire vive",
		"import.created": "Créés",
		"import.updated": "Mis à jour",
		"journal.entry": "Entrée",
		"nav.tableOfContents": "Sommaire",
		"records.noteField": "Remarque",
		"runs.started": "Démarré",
		"usage.lifetime": "Cumul",
	},
	hi: {
		"calls.incoming": "इनकमिंग",
		"dataGrid.checked": "चेक किया गया",
		"dataGrid.unchecked": "चेक नहीं किया गया",
		"departures.destinationColumn": "गंतव्य",
		"hardware.memory": "रैम",
		"import.created": "बनाए गए",
		"import.updated": "अपडेट किए गए",
		"journal.entry": "प्रविष्टि",
		"nav.tableOfContents": "विषय-सूची",
		"records.noteField": "टिप्पणी",
		"runs.started": "शुरू हुआ",
		"usage.lifetime": "अब तक कुल",
	},
	it: {
		"calls.incoming": "In arrivo",
		"dataGrid.checked": "Selezionato",
		"dataGrid.unchecked": "Non selezionato",
		"departures.destinationColumn": "Destinazione",
		"hardware.memory": "Memoria RAM",
		"import.created": "Creati",
		"import.updated": "Aggiornati",
		"journal.entry": "Voce",
		"nav.tableOfContents": "Indice",
		"records.noteField": "Nota",
		"runs.started": "Avviato",
		"usage.lifetime": "Complessivo",
	},
	ja: {
		"calls.incoming": "着信",
		"dataGrid.checked": "チェックあり",
		"dataGrid.unchecked": "チェックなし",
		"departures.destinationColumn": "行き先",
		"hardware.memory": "メモリ",
		"import.created": "作成",
		"import.updated": "更新",
		"journal.entry": "エントリー",
		"nav.tableOfContents": "目次",
		"records.noteField": "備考",
		"runs.started": "開始済み",
		"usage.lifetime": "累計",
	},
	ko: {
		"calls.incoming": "수신",
		"dataGrid.checked": "선택됨",
		"dataGrid.unchecked": "선택 안 됨",
		"departures.destinationColumn": "목적지",
		"hardware.memory": "메모리",
		"import.created": "생성됨",
		"import.updated": "업데이트됨",
		"journal.entry": "항목",
		"nav.tableOfContents": "목차",
		"records.noteField": "메모",
		"runs.started": "시작됨",
		"usage.lifetime": "누적",
	},
	"pt-BR": {
		"calls.incoming": "Recebida",
		"dataGrid.checked": "Marcado",
		"dataGrid.unchecked": "Desmarcado",
		"departures.destinationColumn": "Destino",
		"hardware.memory": "Memória RAM",
		"import.created": "Criados",
		"import.updated": "Atualizados",
		"journal.entry": "Entrada",
		"nav.tableOfContents": "Sumário",
		"records.noteField": "Observação",
		"runs.started": "Iniciado",
		"usage.lifetime": "Acumulado",
	},
	ru: {
		"calls.incoming": "Входящий",
		"dataGrid.checked": "Отмечено",
		"dataGrid.unchecked": "Не отмечено",
		"departures.destinationColumn": "Пункт назначения",
		"hardware.memory": "Оперативная память",
		"import.created": "Создано",
		"import.updated": "Обновлено",
		"journal.entry": "Запись",
		"nav.tableOfContents": "Содержание",
		"records.noteField": "Примечание",
		"runs.started": "Запущено",
		"usage.lifetime": "За всё время",
	},
	"zh-CN": {
		"calls.incoming": "来电",
		"dataGrid.checked": "已勾选",
		"dataGrid.unchecked": "未勾选",
		"departures.destinationColumn": "目的地",
		"hardware.memory": "内存",
		"import.created": "已创建",
		"import.updated": "已更新",
		"journal.entry": "条目",
		"nav.tableOfContents": "目录",
		"records.noteField": "备注",
		"runs.started": "已启动",
		"usage.lifetime": "累计",
	},
};
