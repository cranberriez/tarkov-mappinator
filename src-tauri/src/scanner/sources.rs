use super::model::{SourceHealth, SourceStatus};
use std::{fs, io::ErrorKind, path::Path};

/// Only checks directory access. Never imports files or reads screenshot/log contents.
pub fn probe_directory(raw_path: &str) -> SourceHealth {
    let raw_path = raw_path.trim();
    let (status, detail) = if raw_path.is_empty() {
        (SourceStatus::NotConfigured, "No folder configured.")
    } else if !Path::new(raw_path).is_absolute() {
        (SourceStatus::Unreadable, "Use an absolute folder path.")
    } else {
        match fs::metadata(raw_path) {
            Ok(meta) if !meta.is_dir() => (
                SourceStatus::NotDirectory,
                "This path is a file, not a folder.",
            ),
            Ok(_) => match fs::read_dir(raw_path) {
                Ok(_) => (SourceStatus::Available, "Folder accessible."),
                Err(_) => (
                    SourceStatus::Unreadable,
                    "Unable to list this folder. Check access permissions.",
                ),
            },
            Err(error) if error.kind() == ErrorKind::NotFound => {
                (SourceStatus::Missing, "Folder does not exist.")
            }
            Err(_) => (SourceStatus::Unreadable, "Unable to access this path."),
        }
    };
    SourceHealth {
        status,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_missing_file_and_accessible_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        assert_eq!(probe_directory("").status, SourceStatus::NotConfigured);
        assert_eq!(
            probe_directory(&path.to_string_lossy()).status,
            SourceStatus::Available
        );
        assert_eq!(
            probe_directory(&path.join("missing").to_string_lossy()).status,
            SourceStatus::Missing
        );
        let file = path.join("sample.log");
        fs::write(&file, "").unwrap();
        assert_eq!(
            probe_directory(&file.to_string_lossy()).status,
            SourceStatus::NotDirectory
        );
    }
}

/// Windows resolves redirected Documents through its known-folder provider.
/// No account-specific paths are stored in the application source.
pub fn discover_folders() -> super::model::FolderConfig {
    let mut config = super::model::FolderConfig::default();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(output) = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Environment]::GetFolderPath('MyDocuments')",
            ])
            .creation_flags(0x08000000)
            .output()
        {
            if output.status.success() {
                let documents = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !documents.is_empty() {
                    config.screenshots = Path::new(&documents)
                        .join("Escape from Tarkov")
                        .join("Screenshots")
                        .to_string_lossy()
                        .into_owned();
                }
            }
        }
        for letter in b'C'..=b'Z' {
            for suffix in [
                "Battlestate Games\\EscapeFromTarkov\\Logs",
                "Battlestate Games\\EFT\\Logs",
                "Escape from Tarkov\\Logs",
            ] {
                let candidate =
                    std::path::PathBuf::from(format!("{}:\\{}", letter as char, suffix));
                if candidate.is_dir() {
                    config.logs = candidate.to_string_lossy().into_owned();
                    return config;
                }
            }
        }
    }
    config
}
