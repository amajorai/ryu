//! Sensitive-topic detection.

use super::*;

#[test]
fn sensitive_topic_detection_covers_health_and_religion() {
    let health = detect_sensitive_topics("I have a peanut allergy and take medication");
    assert!(health.contains(&SensitiveTopic::HealthCondition));
    let religion = detect_sensitive_topics("I practice Buddhism and attend temple");
    assert!(religion.contains(&SensitiveTopic::ReligiousBelief));
    assert!(detect_sensitive_topics("I prefer concise release notes").is_empty());
    assert!(detect_sensitive_topics("Please review the terms and conditions").is_empty());
    assert!(detect_sensitive_topics("I went to a birthday party").is_empty());
    assert!(detect_sensitive_topics("I have a medical condition")
        .contains(&SensitiveTopic::HealthCondition));
}
