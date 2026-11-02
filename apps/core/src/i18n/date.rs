//! Locale-aware calendar dates for notification arguments: the weekday, month
//! and day, as `Intl.DateTimeFormat(locale, { weekday: "long", month: "long",
//! day: "numeric" })` prints them for the catalog's locales (Latin digits, like
//! [`super::number`]). A producer sends the date (`{"date": "2026-03-14"}`) and
//! Core writes it the way the recipient reads dates ("Saturday, March 14",
//! "Samstag, 14. März", "3月14日土曜日").

use chrono::{Datelike, NaiveDate};

/// `(pattern, months January..December, weekdays Sunday..Saturday)`; the
/// pattern places `{w}`, `{m}` and `{d}`.
type Names = (&'static str, [&'static str; 12], [&'static str; 7]);

const EN: Names = (
    "{w}, {m} {d}",
    [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ],
    [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ],
);

const AR: Names = (
    "{w}، {d} {m}",
    [
        "يناير",
        "فبراير",
        "مارس",
        "أبريل",
        "مايو",
        "يونيو",
        "يوليو",
        "أغسطس",
        "سبتمبر",
        "أكتوبر",
        "نوفمبر",
        "ديسمبر",
    ],
    [
        "الأحد",
        "الاثنين",
        "الثلاثاء",
        "الأربعاء",
        "الخميس",
        "الجمعة",
        "السبت",
    ],
);

const DE: Names = (
    "{w}, {d}. {m}",
    [
        "Januar",
        "Februar",
        "März",
        "April",
        "Mai",
        "Juni",
        "Juli",
        "August",
        "September",
        "Oktober",
        "November",
        "Dezember",
    ],
    [
        "Sonntag",
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag",
    ],
);

const ES: Names = (
    "{w}, {d} de {m}",
    [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    ],
    [
        "domingo",
        "lunes",
        "martes",
        "miércoles",
        "jueves",
        "viernes",
        "sábado",
    ],
);

const FR: Names = (
    "{w} {d} {m}",
    [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ],
    [
        "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
    ],
);

const HI: Names = (
    "{w}, {d} {m}",
    [
        "जनवरी",
        "फ़रवरी",
        "मार्च",
        "अप्रैल",
        "मई",
        "जून",
        "जुलाई",
        "अगस्त",
        "सितंबर",
        "अक्टूबर",
        "नवंबर",
        "दिसंबर",
    ],
    [
        "रविवार",
        "सोमवार",
        "मंगलवार",
        "बुधवार",
        "गुरुवार",
        "शुक्रवार",
        "शनिवार",
    ],
);

const IT: Names = (
    "{w} {d} {m}",
    [
        "gennaio",
        "febbraio",
        "marzo",
        "aprile",
        "maggio",
        "giugno",
        "luglio",
        "agosto",
        "settembre",
        "ottobre",
        "novembre",
        "dicembre",
    ],
    [
        "domenica",
        "lunedì",
        "martedì",
        "mercoledì",
        "giovedì",
        "venerdì",
        "sabato",
    ],
);

const NUMERIC_MONTHS: [&str; 12] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
];

const JA: Names = (
    "{m}月{d}日{w}",
    NUMERIC_MONTHS,
    [
        "日曜日",
        "月曜日",
        "火曜日",
        "水曜日",
        "木曜日",
        "金曜日",
        "土曜日",
    ],
);

const KO: Names = (
    "{m}월 {d}일 {w}",
    NUMERIC_MONTHS,
    [
        "일요일",
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
    ],
);

const PT_BR: Names = (
    "{w}, {d} de {m}",
    [
        "janeiro",
        "fevereiro",
        "março",
        "abril",
        "maio",
        "junho",
        "julho",
        "agosto",
        "setembro",
        "outubro",
        "novembro",
        "dezembro",
    ],
    [
        "domingo",
        "segunda-feira",
        "terça-feira",
        "quarta-feira",
        "quinta-feira",
        "sexta-feira",
        "sábado",
    ],
);

const RU: Names = (
    "{w}, {d} {m}",
    [
        "января",
        "февраля",
        "марта",
        "апреля",
        "мая",
        "июня",
        "июля",
        "августа",
        "сентября",
        "октября",
        "ноября",
        "декабря",
    ],
    [
        "воскресенье",
        "понедельник",
        "вторник",
        "среда",
        "четверг",
        "пятница",
        "суббота",
    ],
);

const ZH_CN: Names = (
    "{m}月{d}日{w}",
    NUMERIC_MONTHS,
    [
        "星期日",
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六",
    ],
);

fn names(locale: &str) -> &'static Names {
    match locale {
        "ar" => &AR,
        "de" => &DE,
        "es" => &ES,
        "fr" => &FR,
        "hi" => &HI,
        "it" => &IT,
        "ja" => &JA,
        "ko" => &KO,
        "pt-BR" => &PT_BR,
        "ru" => &RU,
        "zh-CN" => &ZH_CN,
        _ => &EN,
    }
}

/// `date` as the weekday, month and day in `locale` (a resolved catalog
/// locale; anything else is English).
pub(super) fn format(locale: &str, date: NaiveDate) -> String {
    let (pattern, months, weekdays) = names(locale);
    let month = months[date.month0() as usize];
    let weekday = weekdays[date.weekday().num_days_from_sunday() as usize];
    pattern
        .replace("{w}", weekday)
        .replace("{m}", month)
        .replace("{d}", &date.day().to_string())
}

/// Parse the `YYYY-MM-DD` calendar date a producer sends.
pub(super) fn parse(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_follow_each_locale() {
        let date = parse("2026-03-14").unwrap();
        let cases = [
            ("en", "Saturday, March 14"),
            ("ar", "السبت، 14 مارس"),
            ("de", "Samstag, 14. März"),
            ("es", "sábado, 14 de marzo"),
            ("fr", "samedi 14 mars"),
            ("hi", "शनिवार, 14 मार्च"),
            ("it", "sabato 14 marzo"),
            ("ja", "3月14日土曜日"),
            ("ko", "3월 14일 토요일"),
            ("pt-BR", "sábado, 14 de março"),
            ("ru", "суббота, 14 марта"),
            ("zh-CN", "3月14日星期六"),
            ("xx", "Saturday, March 14"),
        ];
        for (locale, expected) in cases {
            assert_eq!(format(locale, date), expected, "{locale}");
        }
        assert!(parse("14/03/2026").is_none());
        assert!(parse("2026-02-30").is_none());
    }
}
