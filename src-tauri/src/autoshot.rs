//! Auto-screenshot: presses the in-game screenshot key on a randomised timer while a raid is live
//! and the game window is in front, so positions arrive without manual captures.

use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use ts_rs::TS;

/// Each wait is drawn uniformly from this range at millisecond resolution, so presses never fall
/// on a regular beat. Not user-configurable.
const WAIT_MS: std::ops::RangeInclusive<u64> = 5_000..=15_000;
/// How long the key is held, also random per press.
const HOLD_MS: std::ops::RangeInclusive<u64> = 40..=120;
const TICK: Duration = Duration::from_millis(250);
/// Tarkov's window title, checked instead of opening a handle to the anti-cheat-protected process.
const GAME_WINDOW_TITLE: &str = "EscapeFromTarkov";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct AutoShotConfig {
    pub enabled: bool,
    /// DOM `KeyboardEvent.code` of the in-game screenshot binding, e.g. `PrintScreen`, `F12`.
    pub key: String,
    /// Delete the files these presses produce once their position is read.
    pub delete_after: bool,
}

impl Default for AutoShotConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            key: "PrintScreen".into(),
            delete_after: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutoShotState {
    Off,
    /// Enabled, but not in a live raid or the game isn't focused.
    Waiting,
    Armed,
    Error,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct AutoShotStatus {
    pub config: AutoShotConfig,
    pub state: AutoShotState,
    pub detail: String,
    /// RFC 3339; set while a raid is live.
    pub next_at: Option<String>,
    pub presses: u32,
    pub last_press_at: Option<String>,
}

/// Inputs the timer reads each tick, injected so the schedule is testable without the game.
pub struct Gate {
    pub in_raid: bool,
    pub focused: bool,
}

pub enum Action {
    None,
    Press,
}

struct Inner {
    status: AutoShotStatus,
    next: Option<Instant>,
}

pub struct AutoShot {
    inner: Mutex<Inner>,
    publish: Box<dyn Fn(&AutoShotStatus) + Send + Sync>,
}

impl AutoShot {
    pub fn new(publish: Box<dyn Fn(&AutoShotStatus) + Send + Sync>) -> Arc<Self> {
        let config = AutoShotConfig::default();
        Arc::new(Self {
            inner: Mutex::new(Inner {
                status: AutoShotStatus {
                    state: AutoShotState::Off,
                    detail: "Off.".into(),
                    config,
                    next_at: None,
                    presses: 0,
                    last_press_at: None,
                },
                next: None,
            }),
            publish,
        })
    }

    pub fn status(&self) -> AutoShotStatus {
        self.inner.lock().expect("autoshot state").status.clone()
    }

    pub fn configure(&self, config: AutoShotConfig) -> Result<AutoShotStatus, String> {
        if scancode(&config.key).is_none() {
            return Err(format!("Unsupported key {}.", config.key));
        }
        let status = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Auto-screenshot state unavailable")?;
            if inner.status.config != config {
                inner.status.config = config;
                inner.next = None;
                inner.status.next_at = None;
            }
            inner.status.clone()
        };
        (self.publish)(&status);
        Ok(status)
    }

    /// Advances the schedule one tick; publishes on change and says whether to press now.
    pub fn tick(&self, gate: Gate, now: Instant) -> Action {
        let (action, changed) = {
            let mut inner = self.inner.lock().expect("autoshot state");
            let before = inner.status.clone();
            let action = step(&mut inner, gate, now);
            (
                action,
                (inner.status != before).then(|| inner.status.clone()),
            )
        };
        if let Some(status) = changed {
            (self.publish)(&status);
        }
        action
    }

    pub fn pressed(&self, result: Result<(), String>) {
        let status = {
            let mut inner = self.inner.lock().expect("autoshot state");
            match result {
                Ok(()) => {
                    inner.status.presses += 1;
                    inner.status.last_press_at = Some(chrono::Local::now().to_rfc3339());
                }
                Err(error) => {
                    inner.status.state = AutoShotState::Error;
                    inner.status.detail = error;
                }
            }
            inner.status.clone()
        };
        (self.publish)(&status);
    }
}

fn step(inner: &mut Inner, gate: Gate, now: Instant) -> Action {
    let config = inner.status.config.clone();
    let (state, detail) = if !config.enabled {
        inner.next = None;
        (AutoShotState::Off, "Off.")
    } else if !gate.in_raid {
        inner.next = None;
        (
            AutoShotState::Waiting,
            "Waiting for a live raid while monitoring.",
        )
    } else {
        // Alt-tabbing keeps the schedule; a press that falls due waits for focus.
        let next = *inner.next.get_or_insert_with(|| now + wait());
        if !gate.focused {
            (
                AutoShotState::Waiting,
                "Waiting for the game window to be in front.",
            )
        } else if now >= next {
            inner.next = Some(now + wait());
            set(inner, AutoShotState::Armed, "Capturing on schedule.", now);
            return Action::Press;
        } else {
            (AutoShotState::Armed, "Capturing on schedule.")
        }
    };
    // An error stays visible until the next successful press or a state change.
    if !(inner.status.state == AutoShotState::Error && state == AutoShotState::Armed) {
        set(inner, state, detail, now);
    }
    Action::None
}

fn set(inner: &mut Inner, state: AutoShotState, detail: &str, now: Instant) {
    inner.status.state = state;
    inner.status.detail = detail.into();
    inner.status.next_at = inner.next.map(|next| {
        let wall = SystemTime::now() + next.saturating_duration_since(now);
        chrono::DateTime::<chrono::Local>::from(wall)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
    });
}

/// Uniform in `range`, from the OS random source.
fn random(range: std::ops::RangeInclusive<u64>) -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("OS random source");
    range.start() + u64::from_le_bytes(bytes) % (range.end() - range.start() + 1)
}

fn wait() -> Duration {
    Duration::from_millis(random(WAIT_MS))
}

/// Set-1 scancode and extended-key flag for a DOM `KeyboardEvent.code`.
pub fn scancode(code: &str) -> Option<(u16, bool)> {
    const LETTERS: &[u8; 26] = &[
        0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18,
        0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,
    ];
    if let Some(letter) = code.strip_prefix("Key").filter(|rest| rest.len() == 1) {
        let c = letter.as_bytes()[0];
        return c
            .is_ascii_uppercase()
            .then(|| (LETTERS[(c - b'A') as usize] as u16, false));
    }
    if let Some(digit) = code
        .strip_prefix("Digit")
        .and_then(|rest| rest.parse::<u16>().ok())
    {
        return (digit <= 9).then(|| (if digit == 0 { 0x0B } else { 0x01 + digit }, false));
    }
    if let Some(n) = code
        .strip_prefix('F')
        .and_then(|rest| rest.parse::<u16>().ok())
    {
        return match n {
            1..=10 => Some((0x3A + n, false)),
            11 => Some((0x57, false)),
            12 => Some((0x58, false)),
            _ => None,
        };
    }
    Some(match code {
        "PrintScreen" => (0x37, true),
        "ScrollLock" => (0x46, false),
        "Pause" => (0x45, false),
        "Insert" => (0x52, true),
        "Delete" => (0x53, true),
        "Home" => (0x47, true),
        "End" => (0x4F, true),
        "PageUp" => (0x49, true),
        "PageDown" => (0x51, true),
        "Backquote" => (0x29, false),
        "Minus" => (0x0C, false),
        "Equal" => (0x0D, false),
        "BracketLeft" => (0x1A, false),
        "BracketRight" => (0x1B, false),
        "Backslash" => (0x2B, false),
        "Semicolon" => (0x27, false),
        "Quote" => (0x28, false),
        "Comma" => (0x33, false),
        "Period" => (0x34, false),
        "Slash" => (0x35, false),
        _ => return None,
    })
}

#[cfg(windows)]
pub fn game_focused() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    let mut title = [0u16; 64];
    // SAFETY: a null or stale window yields length 0; the buffer length is passed alongside it.
    let length = unsafe {
        GetWindowTextW(
            GetForegroundWindow(),
            title.as_mut_ptr(),
            title.len() as i32,
        )
    };
    String::from_utf16_lossy(&title[..length.max(0) as usize]) == GAME_WINDOW_TITLE
}

#[cfg(not(windows))]
pub fn game_focused() -> bool {
    false
}

/// Taps the key as hardware scancodes, which games reading raw input see like a keyboard press.
#[cfg(windows)]
pub fn press(code: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    };
    let (scan, extended) = scancode(code).ok_or_else(|| format!("Unsupported key {code}."))?;
    let flags = KEYEVENTF_SCANCODE | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
    let input = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let send = |event: INPUT| {
        // SAFETY: one fully initialised INPUT, with its size.
        let sent = unsafe { SendInput(1, &event, std::mem::size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err(format!(
                "Key press was blocked: {}",
                std::io::Error::last_os_error()
            ))
        }
    };
    send(input(flags))?;
    // Held like a finger would; also, some games poll input per frame and miss a zero-length tap.
    std::thread::sleep(Duration::from_millis(random(HOLD_MS)));
    send(input(flags | KEYEVENTF_KEYUP))
}

#[cfg(not(windows))]
pub fn press(_code: &str) -> Result<(), String> {
    Err("Auto-screenshot is only supported on Windows.".into())
}

/// Runs the timer: each tick reads the gate, and a due press is sent and reported to the scanner.
pub fn spawn(
    autoshot: Arc<AutoShot>,
    in_raid: impl Fn() -> bool + Send + 'static,
    note_press: impl Fn(SystemTime) + Send + 'static,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let gate = Gate {
            in_raid: in_raid(),
            focused: game_focused(),
        };
        if let Action::Press = autoshot.tick(gate, Instant::now()) {
            let config = autoshot.status().config;
            let at = SystemTime::now();
            let result = press(&config.key);
            if result.is_ok() && config.delete_after {
                note_press(at);
            }
            autoshot.pressed(result);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed(config: AutoShotConfig) -> Arc<AutoShot> {
        let autoshot = AutoShot::new(Box::new(|_| {}));
        autoshot
            .configure(AutoShotConfig {
                enabled: true,
                ..config
            })
            .unwrap();
        autoshot
    }

    #[test]
    fn export_frontend_contract() {
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings");
        AutoShotStatus::export_all_to(out).unwrap();
    }

    #[test]
    fn presses_only_in_focused_live_raid_after_random_wait() {
        let autoshot = armed(AutoShotConfig::default());
        let t0 = Instant::now();
        let at = |ms| t0 + Duration::from_millis(ms);
        let gate = |in_raid, focused| Gate { in_raid, focused };
        assert!(matches!(autoshot.tick(gate(false, true), t0), Action::None));
        assert_eq!(autoshot.status().state, AutoShotState::Waiting);
        assert!(matches!(autoshot.tick(gate(true, true), t0), Action::None));
        assert!(matches!(
            autoshot.tick(gate(true, true), at(4_999)),
            Action::None
        ));
        // Due while unfocused: held until focus returns.
        assert!(matches!(
            autoshot.tick(gate(true, false), at(15_001)),
            Action::None
        ));
        assert!(matches!(
            autoshot.tick(gate(true, true), at(15_002)),
            Action::Press
        ));
        assert!(matches!(
            autoshot.tick(gate(true, true), at(20_001)),
            Action::None
        ));
        assert!(matches!(
            autoshot.tick(gate(true, true), at(30_003)),
            Action::Press
        ));
        // Leaving the raid drops the schedule.
        autoshot.tick(gate(false, true), at(30_004));
        assert_eq!(autoshot.status().next_at, None);
    }

    #[test]
    fn waits_are_in_range_and_not_whole_seconds() {
        let waits: Vec<_> = (0..500).map(|_| wait()).collect();
        assert!(waits
            .iter()
            .all(|wait| (5_000..=15_000).contains(&(wait.as_millis() as u64))));
        assert!(
            waits
                .iter()
                .filter(|wait| wait.subsec_millis() != 0)
                .count()
                > 400
        );
    }

    #[test]
    fn rejects_unsupported_key() {
        let autoshot = AutoShot::new(Box::new(|_| {}));
        assert!(autoshot
            .configure(AutoShotConfig {
                key: "MetaLeft".into(),
                ..Default::default()
            })
            .is_err());
    }

    #[test]
    fn maps_common_keys() {
        assert_eq!(scancode("PrintScreen"), Some((0x37, true)));
        assert_eq!(scancode("KeyP"), Some((0x19, false)));
        assert_eq!(scancode("Digit0"), Some((0x0B, false)));
        assert_eq!(scancode("Digit1"), Some((0x02, false)));
        assert_eq!(scancode("F1"), Some((0x3B, false)));
        assert_eq!(scancode("F12"), Some((0x58, false)));
        assert_eq!(scancode("F13"), None);
    }
}
