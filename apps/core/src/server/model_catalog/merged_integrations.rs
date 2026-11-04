//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `build_merged_integrations` through `integration_provider_pins`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Build the merged Integrations directory: the integrations.sh directory folded
/// with the user's Composio toolkits and Treg's public platform catalog, deduped
/// by brand slug. Unsorted and unfiltered — callers apply their own
/// query/sort/pagination. Both the list endpoint and the by-id endpoint share
/// this so they never diverge.
pub(in crate::server) async fn build_merged_integrations(
    state: &ServerState,
) -> Vec<crate::catalog_source::IntegrationBrand> {
    use crate::catalog_source::{
        integration_brand_slug, mark_cheapest_options, IntegrationBrand, IntegrationOption,
    };

    let mut order: Vec<String> = Vec::new();
    let mut by_slug: std::collections::HashMap<String, IntegrationBrand> =
        std::collections::HashMap::new();

    for brand in crate::catalog_source::integrations_sh_brands().await {
        if brand.id.is_empty() {
            continue;
        }
        order.push(brand.id.clone());
        by_slug.insert(brand.id.clone(), brand);
    }

    // Composio toolkits degrade gracefully: a fetch error (or no configured key)
    // just means no composio-sourced brands, not a failed endpoint.
    if let Ok(value) = crate::composio_catalog::list_toolkits(&state.client).await {
        if let Some(data) = value.get("data").and_then(serde_json::Value::as_array) {
            for toolkit in data {
                let name = toolkit
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let toolkit_slug = toolkit
                    .get("slug")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let slug = {
                    let from_name = integration_brand_slug(&name);
                    if from_name.is_empty() {
                        integration_brand_slug(&toolkit_slug)
                    } else {
                        from_name
                    }
                };
                if slug.is_empty() {
                    continue;
                }
                let description = toolkit
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let logo = toolkit
                    .get("logo")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let categories = toolkit
                    .get("categories")
                    .map(composio_toolkit_categories)
                    .unwrap_or_default();
                let composio_option = IntegrationOption {
                    id: format!("composio:{toolkit_slug}"),
                    source: "composio".into(),
                    kind: "composio-toolkit".into(),
                    action: "connect".into(),
                    connection_id: None,
                    name: "Composio toolkit".into(),
                    description: description.clone(),
                    url: (!toolkit_slug.is_empty()).then(|| {
                        format!(
                            "https://composio.dev/toolkits/{}",
                            urlencoding::encode(&toolkit_slug)
                        )
                    }),
                    provider: Some("Composio".into()),
                    capability: None,
                    comparison_key: None,
                    price: None,
                    is_cheapest: false,
                    provider_role: None,
                    available: None,
                    availability_note: None,
                };

                match by_slug.get_mut(&slug) {
                    Some(existing) => {
                        // Slug in both directory and composio: union sources, keep
                        // the directory's logo/description where present.
                        if !existing.sources.iter().any(|s| s == "composio") {
                            existing.sources.push("composio".into());
                        }
                        for cat in categories {
                            if !existing.categories.contains(&cat) {
                                existing.categories.push(cat);
                            }
                        }
                        if existing.description.is_none() {
                            existing.description = description;
                        }
                        if existing.logo.is_none() {
                            existing.logo = logo;
                        }
                        existing.composio_slug = (!toolkit_slug.is_empty())
                            .then_some(toolkit_slug.clone())
                            .or(existing.composio_slug.clone());
                        if !existing
                            .options
                            .iter()
                            .any(|option| option.id == composio_option.id)
                        {
                            existing.options.push(composio_option);
                        }
                    }
                    None => {
                        order.push(slug.clone());
                        by_slug.insert(
                            slug.clone(),
                            IntegrationBrand {
                                id: slug,
                                name: if name.is_empty() {
                                    toolkit_slug.clone()
                                } else {
                                    name
                                },
                                description,
                                logo,
                                categories,
                                sources: vec!["composio".into()],
                                feeds: Vec::new(),
                                // Composio brands carry no directory records; their
                                // connection story is the Composio auth flow, not an
                                // integrations.sh entry.
                                connections: Vec::new(),
                                options: vec![composio_option],
                                composio_slug: (!toolkit_slug.is_empty()).then_some(toolkit_slug),
                                treg_slug: None,
                                ryu_slug: None,
                                suggested_source: None,
                                preferred_source: None,
                                domain: None,
                                popularity: None,
                            },
                        );
                    }
                }
            }
        }
    }

    // The public tool catalogs (Ryu's own and Treg's, Treg parity B8) stay
    // discoverable even when no Composio key is configured. Only each lane's
    // platform index is fetched here; endpoint-level rows are loaded by
    // `integrations_get` for the selected preview so the list does not fan out
    // into one request per platform. Both lanes are shown, each row labelled
    // with its source, in the order `RYU_TOOL_CATALOG_PRECEDENCE` gives.
    let precedence = crate::treg_catalog::precedence();
    let active = crate::treg_catalog::active_lanes(precedence);
    let lanes: Vec<_> = crate::treg_catalog::platform_lane_order(precedence)
        .into_iter()
        .filter(|lane| active.contains(lane))
        .collect();
    // Both lanes are fetched at once, so a slow lane never delays the other.
    // A failing lane is logged (once per cooldown) by the catalog module.
    let lane_platforms = futures_util::future::join_all(
        lanes
            .iter()
            .map(|lane| crate::treg_catalog::platform_summaries(*lane)),
    )
    .await;
    for (lane, platforms) in lanes.into_iter().zip(lane_platforms) {
        let Some(base) = lane.base_url() else {
            continue;
        };
        let platforms = match platforms {
            Ok(platforms) => platforms,
            Err(error) => {
                tracing::debug!(
                    error = %error,
                    lane = lane.source(),
                    "tool catalog unavailable; keeping the other sources"
                );
                continue;
            }
        };
        for platform in platforms {
            let from_label = integration_brand_slug(&platform.label);
            let slug = if from_label.is_empty() {
                integration_brand_slug(&platform.slug)
            } else {
                from_label
            };
            if slug.is_empty() {
                continue;
            }
            let summary = match (
                platform.summary.clone(),
                platform.capabilities,
                platform.endpoints,
            ) {
                (Some(summary), Some(capabilities), Some(endpoints)) => Some(format!(
                    "{summary} · {capabilities} capabilities · {endpoints} endpoints"
                )),
                (Some(summary), _, _) => Some(summary),
                (None, Some(capabilities), Some(endpoints)) => Some(format!(
                    "{capabilities} capabilities · {endpoints} endpoints"
                )),
                (None, _, _) => None,
            };
            let source = lane.source();
            let platform_option = IntegrationOption {
                id: format!("{source}:{}", platform.slug),
                source: source.into(),
                kind: lane.platform_kind().into(),
                action: "chat-setup".into(),
                connection_id: None,
                name: lane.catalog_label().into(),
                description: summary.clone(),
                url: Some(format!(
                    "{base}/catalog/platforms/{}",
                    urlencoding::encode(&platform.slug)
                )),
                provider: Some(lane.provider_label().into()),
                capability: None,
                comparison_key: None,
                price: platform.price.clone(),
                is_cheapest: false,
                provider_role: None,
                available: Some(true),
                availability_note: None,
            };
            let category = platform.category.clone();
            let lane_slug = Some(platform.slug.clone());

            match by_slug.get_mut(&slug) {
                Some(existing) => {
                    if !existing.sources.iter().any(|known| known == source) {
                        existing.sources.push(source.into());
                    }
                    if let Some(category) = category {
                        if !existing.categories.contains(&category) {
                            existing.categories.push(category);
                        }
                    }
                    if existing.description.is_none() {
                        existing.description = summary.clone();
                    }
                    match lane {
                        crate::treg_catalog::CatalogLane::Treg => existing.treg_slug = lane_slug,
                        crate::treg_catalog::CatalogLane::Ryu => existing.ryu_slug = lane_slug,
                    }
                    if !existing
                        .options
                        .iter()
                        .any(|option| option.id == platform_option.id)
                    {
                        existing.options.push(platform_option);
                    }
                }
                None => {
                    order.push(slug.clone());
                    let (treg_slug, ryu_slug) = match lane {
                        crate::treg_catalog::CatalogLane::Treg => (lane_slug, None),
                        crate::treg_catalog::CatalogLane::Ryu => (None, lane_slug),
                    };
                    by_slug.insert(
                        slug.clone(),
                        IntegrationBrand {
                            id: slug,
                            name: platform.label,
                            description: summary,
                            logo: None,
                            categories: category.into_iter().collect(),
                            sources: vec![source.into()],
                            feeds: Vec::new(),
                            connections: Vec::new(),
                            options: vec![platform_option],
                            composio_slug: None,
                            treg_slug,
                            ryu_slug,
                            suggested_source: None,
                            preferred_source: None,
                            domain: None,
                            popularity: None,
                        },
                    );
                }
            }
        }
    }

    let mut merged: Vec<_> = order
        .into_iter()
        .filter_map(|slug| by_slug.remove(&slug))
        .collect();
    // Treg (and Ryu's catalog) before Composio wherever both offer a brand,
    // unless the user pinned the brand to the other source.
    let pins = integration_provider_pins(state).await;
    for brand in &mut merged {
        mark_cheapest_options(&mut brand.options);
        crate::catalog_source::rank_managed_providers(
            brand,
            pins.get(&brand.id).map(String::as_str),
        );
    }
    merged
}

/// The user's per-brand managed-source pins (`integrations-provider-pins`).
pub(crate) async fn integration_provider_pins(
    state: &ServerState,
) -> std::collections::HashMap<String, String> {
    let raw = state
        .preferences
        .get(crate::catalog_source::INTEGRATION_PROVIDER_PINS_PREF)
        .await
        .ok()
        .flatten();
    crate::catalog_source::parse_provider_pins(raw.as_deref())
}
