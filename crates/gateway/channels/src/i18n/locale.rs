//! Map a platform or preference locale tag to one the catalog has.
//!
//! The same rule as Core's `i18n::locale::resolve` and `officialCatalogLocale`
//! in `@ryu/i18n`: an exact tag, then the language in its likely script
//! (`pt-PT` is `pt-BR`, `zh-SG` is `zh-CN`; `zh-TW` and `zh-Hant` have no
//! catalog), else English.

use super::{catalog, ENGLISH};

/// Regions where Chinese is likely written in Traditional script
/// (`Intl.Locale.maximize()`), so a bare `zh-<region>` must not get zh-CN.
/// Mirrors `REGION_SCRIPTS` in `apps/core/src/i18n/locale.rs`.
const TRADITIONAL_CHINESE_REGIONS: &[&str] = &[
    "AU", "BN", "GB", "GF", "HK", "ID", "MO", "PA", "PF", "PH", "PZ", "SR", "TH", "TW", "UK", "US",
    "VD", "VN",
];

/// Map any locale tag (`ja`, `pt-br`, `zh_CN.UTF-8`, `en-US`) to a catalog
/// locale, or English.
pub fn resolve(tag: &str) -> &'static str {
    let tag = tag
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .trim()
        .replace('_', "-");
    if tag.is_empty() {
        return ENGLISH;
    }
    if let Some(found) = catalog::LOCALES
        .iter()
        .find(|locale| locale.eq_ignore_ascii_case(&tag))
    {
        return found;
    }
    let language = tag.split('-').next().unwrap_or_default();
    if language.eq_ignore_ascii_case("zh") && is_traditional_chinese(&tag) {
        return ENGLISH;
    }
    catalog::LOCALES
        .iter()
        .find(|locale| {
            locale
                .split('-')
                .next()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(language))
        })
        .copied()
        .unwrap_or(ENGLISH)
}

/// A Chinese tag written (or likely written) in Traditional script.
fn is_traditional_chinese(tag: &str) -> bool {
    let mut region = None;
    for subtag in tag.split('-').skip(1) {
        let alphabetic = subtag.chars().all(|c| c.is_ascii_alphabetic());
        if subtag.len() == 4 && alphabetic {
            return subtag.eq_ignore_ascii_case("Hant");
        }
        if region.is_none() && subtag.len() == 2 && alphabetic {
            region = Some(subtag.to_ascii_uppercase());
        }
    }
    region.is_some_and(|region| TRADITIONAL_CHINESE_REGIONS.contains(&region.as_str()))
}

/// The catalog locale a platform-reported tag names, or `None` for a missing
/// or blank tag (the caller then uses the owner's locale).
pub fn stored(tag: Option<&str>) -> Option<&'static str> {
    tag.map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(resolve)
}
