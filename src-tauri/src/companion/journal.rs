//! In-memory event journal derived from scanner snapshots. Sequence numbers restart with the app
//! (a new `epoch`); a persistent journal can replace this without changing the contract.
use super::model::{
    CompanionEvent, CurrentRaid, CurrentState, EventBody, GameMode, MapRef, Position, QuestAction,
    RaidPhase,
};
use crate::scanner::ScannerSnapshot;
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};

const RETAINED: usize = 1000;
const REMEMBERED_IDS: usize = 20_000;

/// Map ID → tarkov.dev `normalizedName`.
pub type Resolve<'a> = &'a dyn Fn(&str) -> Option<String>;

#[derive(Default)]
pub struct Journal {
    events: VecDeque<CompanionEvent>,
    seq: u64,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    state: Option<CurrentState>,
}

/// `Pve` / `Regular` / `PvpSeason` (the logs' session mode) → tarkov.dev data set, like `dataMode` in TS.
pub fn data_mode(raw: Option<&str>) -> GameMode {
    let key: String = raw?
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    match key.as_str() {
        "pve" => Some("pve".into()),
        "regular" => Some("regular".into()),
        "pvpseason" => Some("pvp-season".into()),
        _ => None,
    }
}

/// Log timestamps are local and zone-less; RFC 3339 values pass through.
fn rfc3339(value: &str) -> String {
    if chrono::DateTime::parse_from_rfc3339(value).is_ok() {
        return value.into();
    }
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .ok()
        .and_then(|time| time.and_local_timezone(chrono::Local).earliest())
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| value.into())
}

fn fingerprint(parts: impl Hash) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn phase(lifecycle: &str) -> Option<RaidPhase> {
    match lifecycle {
        "loading" => Some(RaidPhase::Loading),
        "active" => Some(RaidPhase::InRaid),
        "ended" => Some(RaidPhase::Ended),
        _ => None,
    }
}

impl Journal {
    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn oldest(&self) -> u64 {
        self.events
            .front()
            .map(|event| event.seq)
            .unwrap_or(self.seq + 1)
    }

    pub fn state(&self) -> CurrentState {
        self.state.clone().unwrap_or(CurrentState {
            scanner_running: false,
            raid: None,
            position: None,
            group: Vec::new(),
        })
    }

    /// Events after `since`, or `None` for a cursor ahead of the journal (another epoch, or invented).
    pub fn since(&self, since: u64) -> Option<Vec<CompanionEvent>> {
        (since <= self.seq).then(|| {
            self.events
                .iter()
                .filter(|event| event.seq > since)
                .cloned()
                .collect()
        })
    }

    fn push(&mut self, id: String, at: String, recovered: bool, mode: GameMode, body: EventBody) {
        if !self.seen.insert(id.clone()) {
            return;
        }
        self.seen_order.push_back(id.clone());
        if self.seen_order.len() > REMEMBERED_IDS {
            if let Some(old) = self.seen_order.pop_front() {
                self.seen.remove(&old);
            }
        }
        self.seq += 1;
        self.events.push_back(CompanionEvent {
            seq: self.seq,
            id,
            at,
            recovered,
            mode,
            body,
        });
        if self.events.len() > RETAINED {
            self.events.pop_front();
        }
    }

    /// Records what changed since the last snapshot. Only contract fields are copied: no filenames,
    /// raid/session IDs, evidence text or log bodies. Returns whether anything changed.
    pub fn observe(&mut self, snapshot: &ScannerSnapshot, resolve: Resolve) -> bool {
        let before = (self.seq, self.state.clone());
        let raid = &snapshot.raid;
        let mode = data_mode(raid.game_mode.as_deref());
        let map = |raw: &Option<String>| {
            raw.as_ref().map(|raw| MapRef {
                raw: raw.clone(),
                normalized_name: resolve(raw),
            })
        };

        // Newest first in the snapshot; journal order is oldest first.
        for event in snapshot.activity.iter().rev() {
            if event.kind != "quest" || event.evidence != "quest_notification" {
                continue;
            }
            let action = match event.action.as_str() {
                "accepted" => QuestAction::Accepted,
                "completed" => QuestAction::Completed,
                "failed" => QuestAction::Failed,
                _ => continue,
            };
            let Some(quest_id) = event.entity_id.clone() else {
                continue;
            };
            let at = rfc3339(event.event_at.as_deref().unwrap_or(&event.logged_at));
            let quest_mode = data_mode(event.game_mode.as_deref());
            let id = format!("quest:{}", event.id.trim_start_matches("event:"));
            self.push(
                id,
                at,
                event.recovered,
                quest_mode,
                EventBody::Quest { action, quest_id },
            );
        }

        let current_raid = phase(&raid.lifecycle).map(|phase| CurrentRaid {
            phase,
            map: map(&raid.map),
            mode: mode.clone(),
            recovered: raid.recovered,
        });
        if let Some(current) = &current_raid {
            let id = format!(
                "raid:{}",
                fingerprint((&raid.lifecycle, &raid.map, &raid.started_at, &mode))
            );
            let at = raid
                .started_at
                .as_deref()
                .map(rfc3339)
                .unwrap_or_else(|| chrono::Local::now().to_rfc3339());
            self.push(
                id,
                at,
                current.recovered,
                mode.clone(),
                EventBody::Raid {
                    phase: current.phase,
                    map: current.map.clone(),
                },
            );
        }

        let position = |observation: &crate::scanner::PositionObservation| Position {
            map: map(&raid.map),
            x: observation.xyz[0],
            y: observation.xyz[1],
            z: observation.xyz[2],
            yaw: observation.heading_degrees,
            captured_at: rfc3339(
                observation
                    .captured_at
                    .as_deref()
                    .unwrap_or(&observation.observed_at),
            ),
        };
        let latest = snapshot.latest_position.as_ref();
        for (observation, recovered) in snapshot
            .recovered_positions
            .iter()
            .map(|p| (p, true))
            .chain(latest.map(|p| (p, snapshot.recovered_positions.contains(p))))
        {
            let id = format!("position:{}", fingerprint(&observation.filename));
            let body = position(observation);
            self.push(
                id,
                body.captured_at.clone(),
                recovered,
                mode.clone(),
                EventBody::Position(body),
            );
        }

        self.state = Some(CurrentState {
            scanner_running: snapshot.monitoring == crate::scanner::MonitoringStatus::Running,
            raid: current_raid,
            position: latest.map(position),
            group: Vec::new(),
        });
        before != (self.seq, self.state.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_match_the_frontend_mapping() {
        assert_eq!(data_mode(Some("Pve")).as_deref(), Some("pve"));
        assert_eq!(data_mode(Some("PvpSeason")).as_deref(), Some("pvp-season"));
        assert_eq!(data_mode(Some("Regular")).as_deref(), Some("regular"));
        assert_eq!(data_mode(Some("FutureMode")), None);
        assert_eq!(data_mode(None), None);
    }

    #[test]
    fn quest_events_carry_the_mode_they_were_logged_in() {
        let quest = |id: &str, mode: &str| crate::scanner::ActivityEvent {
            id: format!("event:{id}"),
            logged_at: "2026-10-11 12:00:00.000".into(),
            event_at: None,
            kind: "quest".into(),
            action: "accepted".into(),
            entity_id: Some("5936d90786f7742b1420ba5b".into()),
            source: "push-notifications".into(),
            evidence: "quest_notification".into(),
            recovered: false,
            summary: String::new(),
            game_mode: Some(mode.into()),
        };
        let mut snapshot = ScannerSnapshot::initial(String::new());
        snapshot.raid.game_mode = Some("PvpSeason".into());
        snapshot.activity = vec![quest("b", "Pve"), quest("a", "Regular")];
        let mut journal = Journal::default();
        journal.observe(&snapshot, &|_| None);
        let modes: Vec<_> = journal.since(0).unwrap().into_iter().map(|e| e.mode).collect();
        assert_eq!(modes, [Some("regular".to_string()), Some("pve".to_string())]);
    }

    #[test]
    fn local_log_times_become_rfc3339() {
        assert!(chrono::DateTime::parse_from_rfc3339(&rfc3339("2026-10-11 12:01:00.000")).is_ok());
        assert_eq!(
            rfc3339("2026-10-11T12:01:00+00:00"),
            "2026-10-11T12:01:00+00:00"
        );
    }

    #[test]
    fn cursor_bounds() {
        let mut journal = Journal::default();
        journal.push(
            "a".into(),
            "t".into(),
            false,
            None,
            EventBody::Quest {
                action: QuestAction::Accepted,
                quest_id: "q".into(),
            },
        );
        journal.push(
            "a".into(),
            "t".into(),
            false,
            None,
            EventBody::Quest {
                action: QuestAction::Accepted,
                quest_id: "q".into(),
            },
        );
        assert_eq!(journal.seq(), 1, "duplicate ids are ignored");
        assert_eq!(journal.since(0).unwrap().len(), 1);
        assert_eq!(journal.since(1).unwrap().len(), 0);
        assert!(journal.since(2).is_none());
    }
}
