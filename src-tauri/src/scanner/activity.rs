//! Safe projections only: raw messages, hosts and payloads never enter snapshots.
use super::{
    model::ActivityEvent,
    parsers::{self, LogEvent},
};
use chrono::NaiveDateTime;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

/// Stable record identity shared by monitoring and import, so stored history deduplicates
/// across runs and builds. Quest notifications are identified by content (a redelivered or
/// rotated copy matches); anything else by its exact line within its session and source.
pub fn fingerprint(event: Option<&ActivityEvent>, session: &str, source: &str, line: &str) -> u64 {
    let mut hash = Sha256::new();
    let parts: [&str; 5] = match event.filter(|e| e.evidence == "quest_notification") {
        Some(e) => ["quest", &e.kind, &e.action, e.entity_id.as_deref().unwrap_or(""), e.event_at.as_deref().unwrap_or("")],
        None => ["line", session, source, line, ""],
    };
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    u64::from_be_bytes(hash.finalize()[..8].try_into().expect("8 bytes"))
}

/// Mode in effect at `logged_at`: the latest `(timestamp, mode)` entry at or before it, from a
/// timeline sorted by timestamp. Never falls back to a later entry.
pub fn mode_at<'a>(timeline: &'a [(String, String)], logged_at: &str) -> Option<&'a str> {
    let end = timeline.partition_point(|(at, _)| at.as_str() <= logged_at);
    end.checked_sub(1).map(|i| timeline[i].1.as_str())
}

pub fn event_id(fingerprint: u64) -> String {
    format!("event:{fingerprint:016x}")
}

pub struct Record<'a> {
    pub timestamp: &'a str,
    pub level: &'a str,
    pub category: &'a str,
    pub message: &'a str,
}
pub fn record(line: &str) -> Option<Record<'_>> {
    let line = line.lines().next()?;
    static HEADER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:[0-5][0-9]\.\d{3})\|\d+\.\d+\.\d+\.\d+\.\d+\|(Info|Debug|Warn|Error|Trace|Fatal)\|([^|\r\n]{0,64})\|(.*)$").unwrap()
    });
    let fields = HEADER.captures(line)?;
    let timestamp = fields.get(1)?.as_str();
    NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S%.f").ok()?;
    Some(Record {
        timestamp,
        level: fields.get(2)?.as_str(),
        category: fields.get(3)?.as_str(),
        message: fields.get(4)?.as_str(),
    })
}
pub fn safe_category(category: &str) -> &str {
    match category {
        "application" | "output" | "backend" | "notifications" | "push-notifications"
        | "errors" | "traces" | "hideout" | "ai" | "asserts" => category,
        _ => "other",
    }
}
pub fn source_class(name: &str) -> &'static str {
    for class in [
        "application",
        "output",
        "backend",
        "push-notifications",
        "notifications",
        "errors",
        "traces",
        "hideout",
        "ai",
        "asserts",
    ] {
        if name.starts_with(class)
            || name.contains(&format!("_{class}"))
            || name.contains(&format!(" {class}_"))
        {
            return class;
        }
    }
    "other"
}
pub fn event(line: &str, source: &str, id: String, recovered: bool) -> Option<ActivityEvent> {
    let record = record(line)?;
    if record.category == "push-notifications"
        && record.level == "Info"
        && record.message == "Got notification | ChatMessageReceived"
    {
        let (_, json) = line.split_once('\n')?;
        let payload: serde_json::Value = serde_json::from_str(json).ok()?;
        if payload["type"].as_str()? != "new_message" {
            return None;
        }
        let message = &payload["message"];
        let (action, suffix, summary) = match message["type"].as_u64()? {
            10 => (
                "accepted",
                "description",
                "Quest acceptance system notification received.",
            ),
            11 => (
                "failed",
                "failMessageText",
                "Quest failure system notification received.",
            ),
            12 => (
                "completed",
                "successMessageText",
                "Quest completion system notification received.",
            ),
            _ => return None,
        };
        let (entity, template) = message["templateId"].as_str()?.split_once(' ')?;
        if entity.len() != 24
            || !entity.bytes().all(|b| b.is_ascii_hexdigit())
            || (template != suffix && !(action == "accepted" && template == "startedMessageText"))
        {
            return None;
        }
        let dt = message["dt"].as_i64()?;
        if !(946684800..4102444800).contains(&dt) {
            return None;
        }
        let event_at = chrono::DateTime::from_timestamp(dt, 0)?.to_rfc3339();
        return Some(ActivityEvent {
            id,
            logged_at: record.timestamp.into(),
            event_at: Some(event_at),
            kind: "quest".into(),
            action: action.into(),
            entity_id: Some(entity.to_ascii_lowercase()),
            source: source.into(),
            evidence: "quest_notification".into(),
            recovered,
            summary: summary.into(),
            game_mode: None,
        });
    }
    let (kind, action, evidence, summary) = if let Some((_, event)) = parsers::log_record(line) {
        match event {
            LogEvent::Started => (
                "raid",
                "started",
                "observed",
                "GameStarted logged; raid start observed.",
            ),
            LogEvent::Ended => (
                "raid",
                "ended",
                "observed",
                "Client disconnected to stop game; extraction outcome unknown.",
            ),
            LogEvent::LocalEndReported => (
                "raid",
                "end_reported",
                "requested",
                "Client reported local raid end; outcome and acknowledgment unknown.",
            ),
            LogEvent::Loading { .. } => (
                "raid",
                "loading",
                "observed",
                "Network game creation logged.",
            ),
            LogEvent::Scene(_) => (
                "raid",
                "scene_loading",
                "observed",
                "Raid scene loading logged.",
            ),
            LogEvent::Mode(_) => (
                "session",
                "mode_changed",
                "observed",
                "Session mode logged.",
            ),
        }
    } else if record.category == "backend" && record.level == "Info" {
        static REQUEST: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^---> Request HTTPS, id \[\d+\]: URL: https://[A-Za-z0-9.-]+(?::\d+)?(/client/[A-Za-z0-9/_-]+(?:\?completed=True)?)\. ?$").unwrap()
        });
        let action = REQUEST.captures(record.message)?;
        match &action[1] {
            "/client/quest/fail" => (
                "quest",
                "fail_requested",
                "requested",
                "Quest failure request logged; quest ID and outcome unavailable.",
            ),
            "/client/game/profile/items/moving" => (
                "inventory",
                "move_requested",
                "requested",
                "Inventory operation requested; items and outcome unavailable.",
            ),
            "/client/match/local/start" | "/client/game/start" => (
                "raid",
                "start_requested",
                "requested",
                "Game start requested; request alone does not confirm a raid start.",
            ),
            "/client/match/join" => (
                "session",
                "join_requested",
                "requested",
                "Match join requested; resulting session state unavailable.",
            ),
            "/client/match/group/exit_from_menu" => (
                "session",
                "group_exit_requested",
                "requested",
                "Group exit requested from menu.",
            ),
            "/client/mail/dialog/getAllAttachments" => (
                "mail",
                "attachments_requested",
                "requested",
                "Mail attachments requested; successful claim unconfirmed.",
            ),
            "/client/quest/list" | "/client/quest/chains" => (
                "quest",
                "data_read_requested",
                "requested",
                "Quest catalog data requested; no quest transition inferred.",
            ),
            "/client/quest/getMainQuestsList" | "/client/quest/getMainQuestNotesList" => (
                "story",
                "data_read_requested",
                "requested",
                "Story quest or notes data requested; no progression inferred.",
            ),
            "/client/achievement/list"
            | "/client/achievement/list?completed=True"
            | "/client/achievement/statistic" => (
                "achievement",
                "data_read_requested",
                "requested",
                "Achievement data requested; no earned achievement inferred.",
            ),
            "/client/mail/dialog/list" => (
                "mail",
                "data_read_requested",
                "requested",
                "Mail dialog list requested.",
            ),
            "/client/hideout/settings"
            | "/client/hideout/areas"
            | "/client/hideout/production/recipes" => (
                "hideout",
                "data_read_requested",
                "requested",
                "Hideout configuration or recipes requested; no production outcome inferred.",
            ),
            "/client/profile/status"
            | "/client/match/group/current"
            | "/client/match/available"
            | "/client/raid/configuration" => (
                "session",
                "data_read_requested",
                "requested",
                "Session or raid context requested; no outcome inferred.",
            ),
            _ => return None,
        }
    } else {
        return None;
    };
    Some(ActivityEvent {
        id,
        logged_at: record.timestamp.into(),
        event_at: None,
        kind: kind.into(),
        action: action.into(),
        entity_id: None,
        source: source.into(),
        evidence: evidence.into(),
        recovered,
        summary: summary.into(),
        game_mode: None,
    })
}

/// Only this evidenced JSON envelope needs multiline assembly. Invalid/incomplete
/// payloads stay private and bounded; a subsequent header closes an invalid block.
pub fn assemble(lines: &str, pending: &mut Option<(String, String)>) -> Vec<String> {
    let mut records = Vec::new();
    for line in lines.lines() {
        if let Some(header) = record(line) {
            if let Some((previous, _)) = pending.take() {
                records.push(previous);
            }
            if header.category == "push-notifications"
                && header.message == "Got notification | ChatMessageReceived"
            {
                *pending = Some((line.into(), String::new()));
            } else {
                records.push(line.into());
            }
        } else if let Some((_, json)) = pending.as_mut() {
            json.push_str(line);
            json.push('\n');
            if json.len() > 64 * 1024 {
                if let Some((header, _)) = pending.take() {
                    records.push(header);
                }
            } else if serde_json::from_str::<serde_json::Value>(json).is_ok() {
                if let Some((header, json)) = pending.take() {
                    records.push(format!("{header}\n{json}"));
                }
            }
        }
    }
    records
}

pub fn sort_time(event: &ActivityEvent) -> i64 {
    event
        .event_at
        .as_ref()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.timestamp_millis())
        .or_else(|| {
            NaiveDateTime::parse_from_str(&event.logged_at, "%Y-%m-%d %H:%M:%S%.f")
                .ok()?
                .and_local_timezone(chrono::Local)
                .earliest()
                .map(|v| v.timestamp_millis())
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    const PUSH: &str = include_str!("../../../fixtures/activity/push-notifications.log");
    #[test]
    fn observed_system_notifications_use_type_template_and_original_time_not_text() {
        let records = assemble(PUSH, &mut None);
        let events: Vec<_> = records
            .iter()
            .filter_map(|r| event(r, "push-notifications", "test".into(), true))
            .collect();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].action, "accepted");
        assert_eq!(
            events[0].entity_id.as_deref(),
            Some("5fd9fad9c1ce6b1a3b486d00")
        );
        assert_eq!(events[2].action, "completed");
        assert_eq!(events[1].evidence, "quest_notification");
        assert!(events[0].event_at.is_some());
        for invalid in [
            records[0].replace("\"type\": 10", "\"type\": 1"),
            records[0].replace("description", "successMessageText"),
            records[0].replace("new_message", "user_message"),
            records[0].replace("ChatMessageReceived", "Ping"),
            records[0].replace("1791743417", "null"),
            records[0].replace("5fd9fad9c1ce6b1a3b486d00", "not-a-quest"),
        ] {
            assert!(event(&invalid, "push-notifications", "test".into(), false).is_none());
        }
        // Protocol-only failure shape; no locally observed failure notification fixture.
        let synthetic_fail = records[0]
            .replace("\"type\": 10", "\"type\": 11")
            .replace("description", "failMessageText");
        assert_eq!(
            event(&synthetic_fail, "push-notifications", "test".into(), false)
                .unwrap()
                .action,
            "failed"
        );
        let safe = serde_json::to_string(&events).unwrap();
        for private in [
            "REDACTED_ID",
            "quest started",
            "stash",
            "profileChangeEvents",
        ] {
            assert!(!safe.contains(private));
        }
        assert_eq!(
            source_class("2026.10.11_11-03-07_1.2.0.0.47965 application_000.log"),
            "application"
        );
        assert_eq!(
            source_class("2026.10.11_11-03-07_1.2.0.0.47965 push-notifications_000.log"),
            "push-notifications"
        );
    }
    #[test]
    fn observed_other_requests_are_safe_intent_without_outcome() {
        let fixture = include_str!("../../../fixtures/activity/other-requests.log");
        let events: Vec<_> = fixture
            .lines()
            .filter_map(|r| event(r, "backend", "test".into(), true))
            .collect();
        assert_eq!(events.len(), 11);
        assert!(events
            .iter()
            .all(|e| e.evidence == "requested" && e.entity_id.is_none()));
        assert!(events.iter().any(|e| e.kind == "story"));
        assert!(events.iter().any(|e| e.kind == "hideout"));
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("example.invalid"));
    }
}
