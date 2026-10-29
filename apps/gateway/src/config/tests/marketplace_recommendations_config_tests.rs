use super::{GatewayConfig, MarketplaceRecommendationsCadence};

#[test]
fn defaults_and_toml_round_trip_preserve_weekly_policy() {
    let mut config = GatewayConfig::default();
    assert!(config.marketplace_recommendations.enabled);
    assert_eq!(
        config.marketplace_recommendations.cadence,
        MarketplaceRecommendationsCadence::Weekly
    );

    config.marketplace_recommendations.cadence = MarketplaceRecommendationsCadence::Monthly;
    let encoded = toml::to_string(&config).expect("serialize gateway config");
    let decoded: GatewayConfig = toml::from_str(&encoded).expect("deserialize gateway config");
    assert_eq!(
        decoded.marketplace_recommendations,
        config.marketplace_recommendations
    );
}

#[test]
fn cadence_accepts_only_daily_weekly_or_monthly() {
    for cadence in ["daily", "weekly", "monthly"] {
        let value = format!("cadence = \"{cadence}\"");
        toml::from_str::<super::MarketplaceRecommendationsConfig>(&value)
            .expect("supported cadence");
    }
    assert!(
        toml::from_str::<super::MarketplaceRecommendationsConfig>("cadence = \"hourly\"").is_err()
    );
}
