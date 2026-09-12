//! Agent-trust hashes: bounded walks over agent config files.
use std::fs;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::util::{missing_path, opt_s, s};

/// The trust-hash walk fails closed after this many files.
const TRUST_MAX_FILES: usize = 10_000;
/// The trust-hash walk fails closed after this many bytes.
const TRUST_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Trust files larger than this fail the walk.
const TRUST_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

struct TrustBudget {
    max_files: usize,
    max_bytes: u64,
    max_file_bytes: u64,
}

impl TrustBudget {
    fn production() -> Self {
        Self {
            max_files: TRUST_MAX_FILES,
            max_bytes: TRUST_MAX_BYTES,
            max_file_bytes: TRUST_MAX_FILE_BYTES,
        }
    }
}

pub(crate) fn op_trust_hashes(req: &Value) -> Result<Value, String> {
    let agent_dir = PathBuf::from(s(req, "agentDir")?);
    let project_root = opt_s(req, "projectRoot").map(PathBuf::from);
    let state = collect_trust_hashes(
        &agent_dir,
        project_root.as_deref(),
        &TrustBudget::production(),
    )?;
    Ok(json!({ "state": Value::Object(state), "complete": true }))
}

fn collect_trust_hashes(
    agent_dir: &Path,
    project_root: Option<&Path>,
    budget: &TrustBudget,
) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    let mut files = 0usize;
    let mut bytes = 0u64;

    for name in [
        "settings.json",
        "models.json",
        "models-store.json",
        "prompts",
        "skills",
        "themes",
        "extensions",
    ] {
        let full = agent_dir.join(name);
        let key = format!("agent/{name}");
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(error) if missing_path(&error) => continue,
            Err(error) => return Err(format!("stat trust path {key} failed: {error}")),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!("trust path {key} is a symlink"));
        }
        if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, &mut out, &mut files, &mut bytes, budget)?;
        } else if metadata.file_type().is_file() {
            let (key, hash) = hash_file(&full, &key, &mut files, &mut bytes, budget)?;
            out.insert(key, Value::String(hash));
        } else {
            return Err(format!("trust path {key} has an unsupported file type"));
        }
    }
    if let Some(root) = project_root {
        for rel in [".agents/skills"] {
            walk_hashes(
                &root.join(rel),
                &format!("project/{rel}"),
                &mut out,
                &mut files,
                &mut bytes,
                budget,
            )?;
        }
    }
    Ok(out)
}

fn walk_hashes(
    abs_root: &Path,
    prefix: &str,
    out: &mut serde_json::Map<String, Value>,
    files: &mut usize,
    bytes: &mut u64,
    budget: &TrustBudget,
) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(abs_root) {
        Ok(metadata) => metadata,
        Err(error) if missing_path(&error) => return Ok(()),
        Err(error) => return Err(format!("stat trust path {prefix} failed: {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("trust path {prefix} is a symlink"));
    }
    if !metadata.file_type().is_dir() {
        return Err(format!("trust path {prefix} is not a directory"));
    }

    let mut names = Vec::new();
    let entries = fs::read_dir(abs_root)
        .map_err(|error| format!("read trust directory {prefix} failed: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("read trust directory {prefix} failed: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| format!("trust path {prefix} contains a non-UTF-8 name"))?;
        names.push(name);
    }
    names.sort_unstable();

    for name in names {
        let full = abs_root.join(&name);
        let key = format!("{prefix}/{name}");
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(error) if missing_path(&error) => {
                return Err(format!("trust path {key} vanished during the walk"));
            }
            Err(error) => return Err(format!("stat trust path {key} failed: {error}")),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!("trust path {key} is a symlink"));
        }
        if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, out, files, bytes, budget)?;
        } else if metadata.file_type().is_file() {
            let (key, hash) = hash_file(&full, &key, files, bytes, budget)?;
            out.insert(key, Value::String(hash));
        } else {
            return Err(format!("trust path {key} has an unsupported file type"));
        }
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    key: &str,
    files: &mut usize,
    bytes: &mut u64,
    budget: &TrustBudget,
) -> Result<(String, String), String> {
    if *files >= budget.max_files {
        return Err(format!("trust hash walk exceeded its file budget: {key}"));
    }

    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                format!("trust path {key} is a symlink")
            } else {
                format!("open trust file {key} failed: {error}")
            }
        })?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("stat trust file {key} failed: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("trust path {key} is not a regular file"));
    }
    let len = metadata.len();
    if len > budget.max_file_bytes {
        return Err(format!("trust file {key} exceeds the per-file byte budget"));
    }
    if bytes
        .checked_add(len)
        .map(|total| total > budget.max_bytes)
        .unwrap_or(true)
    {
        return Err(format!("trust hash walk exceeded its byte budget: {key}"));
    }

    let mut content = Vec::new();
    file.read_to_end(&mut content)
        .map_err(|error| format!("read trust file {key} failed: {error}"))?;
    let read_len = u64::try_from(content.len())
        .map_err(|_| format!("trust file {key} length does not fit u64"))?;
    if read_len > budget.max_file_bytes {
        return Err(format!(
            "trust file {key} grew past the per-file byte budget"
        ));
    }
    if bytes
        .checked_add(read_len)
        .map(|total| total > budget.max_bytes)
        .unwrap_or(true)
    {
        return Err(format!("trust hash walk exceeded its byte budget: {key}"));
    }

    *files += 1;
    *bytes += read_len;
    let digest = Sha256::digest(&content);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((key.to_string(), hex))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs as unix_fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        agent: PathBuf,
        project: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            loop {
                let root = std::env::temp_dir().join(format!(
                    "termina-trust-{}-{}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&root) {
                    Ok(()) => {
                        let agent = root.join("agent");
                        let project = root.join("project");
                        fs::create_dir(&agent).unwrap();
                        fs::create_dir(&project).unwrap();
                        return Self {
                            root,
                            agent,
                            project,
                        };
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create trust fixture: {error}"),
                }
            }
        }

        fn req(&self) -> Value {
            json!({
                "agentDir": self.agent.to_str().unwrap(),
                "projectRoot": self.project.to_str().unwrap(),
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn state_keys(value: &Value) -> Vec<&str> {
        value["state"]
            .as_object()
            .expect("trust hashes return a state object")
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn sorted_walks_match() {
        let fixture = Fixture::new();
        let skills = fixture.agent.join("skills");
        let nested = skills.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(skills.join("z.txt"), b"z").unwrap();
        fs::write(skills.join("a.txt"), b"a").unwrap();
        fs::write(skills.join("m.txt"), b"m").unwrap();
        fs::write(nested.join("z.txt"), b"nz").unwrap();
        fs::write(nested.join("a.txt"), b"na").unwrap();

        let first = op_trust_hashes(&fixture.req()).unwrap();
        let second = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["complete"], true);
        assert_eq!(state_keys(&first), [
            "agent/skills/a.txt",
            "agent/skills/m.txt",
            "agent/skills/nested/a.txt",
            "agent/skills/nested/z.txt",
            "agent/skills/z.txt",
        ]);
        assert_eq!(first["state"]["agent/skills/a.txt"], sha256_hex(b"a"));
    }

    #[test]
    fn file_budget_overflow_errors() {
        let fixture = Fixture::new();
        let skills = fixture.agent.join("skills");
        fs::create_dir(&skills).unwrap();
        // Created out of sort order so an unordered walk would overflow at m,
        // while a sorted walk overflows at z.
        fs::write(skills.join("z.txt"), b"z").unwrap();
        fs::write(skills.join("a.txt"), b"a").unwrap();
        fs::write(skills.join("m.txt"), b"m").unwrap();

        let error = collect_trust_hashes(&fixture.agent, Some(&fixture.project), &TrustBudget {
            max_files: 2,
            max_bytes: TRUST_MAX_BYTES,
            max_file_bytes: TRUST_MAX_FILE_BYTES,
        })
        .unwrap_err();
        assert!(
            error.contains("file budget"),
            "expected a file-budget error, got {error}"
        );
        assert!(
            error.contains("agent/skills/z.txt"),
            "sorted overflow should fail on z.txt, got {error}"
        );
    }

    #[test]
    fn byte_budget_overflow_errors() {
        let fixture = Fixture::new();
        fs::write(fixture.agent.join("settings.json"), b"0123456789abcdef").unwrap();

        let error = collect_trust_hashes(&fixture.agent, Some(&fixture.project), &TrustBudget {
            max_files: TRUST_MAX_FILES,
            max_bytes: 8,
            max_file_bytes: TRUST_MAX_FILE_BYTES,
        })
        .unwrap_err();
        assert!(
            error.contains("byte budget"),
            "expected a byte-budget error, got {error}"
        );
        assert!(
            error.contains("agent/settings.json"),
            "byte overflow should name the overflowing file, got {error}"
        );
    }

    #[test]
    fn symlink_settings_json_fails_instead_of_following() {
        let fixture = Fixture::new();
        let foreign = fixture.root.join("foreign-settings.json");
        fs::write(&foreign, b"foreign-secret-bytes").unwrap();
        unix_fs::symlink(&foreign, fixture.agent.join("settings.json")).unwrap();

        let error = op_trust_hashes(&fixture.req()).unwrap_err();
        assert!(
            error.contains("symlink"),
            "expected a symlink error, got {error}"
        );
        assert!(
            !error.contains(&sha256_hex(b"foreign-secret-bytes")),
            "symlink walk must not hash the foreign target, got {error}"
        );
    }

    #[test]
    fn absent_roots_report_a_complete_empty_map() {
        let fixture = Fixture::new();
        let result = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["state"], json!({}));
    }
}
