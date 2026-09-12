//! Agent-trust hashes: bounded walks over agent config files.
use std::fs;
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
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
/// Stored symlink identities are tagged so they cannot collide with a
/// regular file whose bytes happen to be `symlink\0` plus a path.
const SYMLINK_DIGEST_PREFIX: &str = "symlink:";

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
    // The map key is `hashes`, not `state`: the client resolves `msg.state`
    // when present, which would strip `complete` from the envelope.
    Ok(json!({ "hashes": Value::Object(state), "complete": true }))
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
            record_hash(
                &mut out,
                hash_symlink(&full, &key, &mut files, &mut bytes, budget)?,
            );
        } else if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, &mut out, &mut files, &mut bytes, budget)?;
        } else if metadata.file_type().is_file() {
            record_hash(
                &mut out,
                hash_file(&full, &key, &mut files, &mut bytes, budget)?,
            );
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
        record_hash(out, hash_symlink(abs_root, prefix, files, bytes, budget)?);
        return Ok(());
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
            record_hash(out, hash_symlink(&full, &key, files, bytes, budget)?);
        } else if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, out, files, bytes, budget)?;
        } else if metadata.file_type().is_file() {
            record_hash(out, hash_file(&full, &key, files, bytes, budget)?);
        } else {
            return Err(format!("trust path {key} has an unsupported file type"));
        }
    }
    Ok(())
}

fn record_hash(out: &mut serde_json::Map<String, Value>, hashed: (String, String)) {
    out.insert(hashed.0, Value::String(hashed.1));
}

fn charge_budget(
    key: &str,
    len: u64,
    files: &mut usize,
    bytes: &mut u64,
    budget: &TrustBudget,
) -> Result<(), String> {
    if *files >= budget.max_files {
        return Err(format!("trust hash walk exceeded its file budget: {key}"));
    }
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
    Ok(())
}

fn hash_symlink(
    path: &Path,
    key: &str,
    files: &mut usize,
    bytes: &mut u64,
    budget: &TrustBudget,
) -> Result<(String, String), String> {
    let target = fs::read_link(path)
        .map_err(|error| format!("readlink trust path {key} failed: {error}"))?;
    let mut content = b"symlink\0".to_vec();
    content.extend_from_slice(target.as_os_str().as_bytes());
    let len = u64::try_from(content.len())
        .map_err(|_| format!("trust symlink {key} length does not fit u64"))?;
    charge_budget(key, len, files, bytes, budget)?;
    *files += 1;
    *bytes += len;
    Ok((
        key.to_string(),
        format!("{SYMLINK_DIGEST_PREFIX}{}", hex_sha256(&content)),
    ))
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

    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return hash_symlink(path, key, files, bytes, budget);
        }
        Err(error) => return Err(format!("open trust file {key} failed: {error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("stat trust file {key} failed: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("trust path {key} is not a regular file"));
    }
    let read_cap = budget
        .max_file_bytes
        .checked_add(1)
        .ok_or_else(|| format!("trust file {key} byte budget overflow"))?;
    let mut content = Vec::new();
    std::io::Read::take(&mut file, read_cap)
        .read_to_end(&mut content)
        .map_err(|error| format!("read trust file {key} failed: {error}"))?;
    let read_len = u64::try_from(content.len())
        .map_err(|_| format!("trust file {key} length does not fit u64"))?;
    charge_budget(key, read_len, files, bytes, budget)?;

    *files += 1;
    *bytes += read_len;
    Ok((key.to_string(), hex_sha256(&content)))
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
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
        hex_sha256(bytes)
    }

    fn symlink_digest(target: &Path) -> String {
        let mut content = b"symlink\0".to_vec();
        content.extend_from_slice(target.as_os_str().as_bytes());
        format!("{SYMLINK_DIGEST_PREFIX}{}", hex_sha256(&content))
    }

    fn state_keys(value: &Value) -> Vec<&str> {
        value["hashes"]
            .as_object()
            .expect("trust hashes return a hashes map")
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
        assert_eq!(
            state_keys(&first),
            [
                "agent/skills/a.txt",
                "agent/skills/m.txt",
                "agent/skills/nested/a.txt",
                "agent/skills/nested/z.txt",
                "agent/skills/z.txt",
            ]
        );
        assert_eq!(first["hashes"]["agent/skills/a.txt"], sha256_hex(b"a"));
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

        let error = collect_trust_hashes(
            &fixture.agent,
            Some(&fixture.project),
            &TrustBudget {
                max_files: 2,
                max_bytes: TRUST_MAX_BYTES,
                max_file_bytes: TRUST_MAX_FILE_BYTES,
            },
        )
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

        let error = collect_trust_hashes(
            &fixture.agent,
            Some(&fixture.project),
            &TrustBudget {
                max_files: TRUST_MAX_FILES,
                max_bytes: 8,
                max_file_bytes: TRUST_MAX_FILE_BYTES,
            },
        )
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
    fn repeated_over_budget_walks_fail_identically() {
        let fixture = Fixture::new();
        let skills = fixture.agent.join("skills");
        fs::create_dir(&skills).unwrap();
        for name in ["z.txt", "a.txt", "m.txt", "k.txt", "q.txt"] {
            fs::write(skills.join(name), b"skill-bytes").unwrap();
        }
        let budget = TrustBudget {
            max_files: 3,
            max_bytes: TRUST_MAX_BYTES,
            max_file_bytes: TRUST_MAX_FILE_BYTES,
        };
        let first =
            collect_trust_hashes(&fixture.agent, Some(&fixture.project), &budget).unwrap_err();
        let second =
            collect_trust_hashes(&fixture.agent, Some(&fixture.project), &budget).unwrap_err();
        assert_eq!(first, second);
        assert!(first.contains("file budget"), "got {first}");
    }

    #[test]
    fn symlink_settings_json_hashes_link_not_target() {
        let fixture = Fixture::new();
        let foreign = fixture.root.join("foreign-settings.json");
        fs::write(&foreign, b"foreign-secret-bytes").unwrap();
        unix_fs::symlink(&foreign, fixture.agent.join("settings.json")).unwrap();

        let first = op_trust_hashes(&fixture.req()).unwrap();
        let second = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first["complete"], true);
        assert_eq!(
            first["hashes"]["agent/settings.json"],
            symlink_digest(&foreign)
        );
        assert_ne!(
            first["hashes"]["agent/settings.json"],
            sha256_hex(b"foreign-secret-bytes")
        );

        let other = fixture.root.join("other-settings.json");
        fs::write(&other, b"foreign-secret-bytes").unwrap();
        fs::remove_file(fixture.agent.join("settings.json")).unwrap();
        unix_fs::symlink(&other, fixture.agent.join("settings.json")).unwrap();
        let retargeted = op_trust_hashes(&fixture.req()).unwrap();
        assert_ne!(
            retargeted["hashes"]["agent/settings.json"],
            first["hashes"]["agent/settings.json"]
        );
        assert_eq!(
            retargeted["hashes"]["agent/settings.json"],
            symlink_digest(&other)
        );
    }

    #[test]
    fn directory_symlink_is_link_identity_not_walked() {
        let fixture = Fixture::new();
        let foreign_skills = fixture.root.join("foreign-skills");
        fs::create_dir(&foreign_skills).unwrap();
        fs::write(foreign_skills.join("secret.txt"), b"foreign-secret-bytes").unwrap();
        unix_fs::symlink(&foreign_skills, fixture.agent.join("skills")).unwrap();

        let result = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(state_keys(&result), ["agent/skills"]);
        assert_eq!(
            result["hashes"]["agent/skills"],
            symlink_digest(&foreign_skills)
        );
        assert!(result["hashes"].get("agent/skills/secret.txt").is_none());
        assert_ne!(
            result["hashes"]["agent/skills"],
            sha256_hex(b"foreign-secret-bytes")
        );
    }

    #[test]
    fn nested_file_symlink_hashes_link_not_target() {
        let fixture = Fixture::new();
        let skills = fixture.agent.join("skills");
        fs::create_dir(&skills).unwrap();
        let foreign = fixture.root.join("foreign-skill.md");
        fs::write(&foreign, b"foreign-secret-bytes").unwrap();
        unix_fs::symlink(&foreign, skills.join("linked.md")).unwrap();
        fs::write(skills.join("local.md"), b"local").unwrap();

        let result = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(
            state_keys(&result),
            ["agent/skills/linked.md", "agent/skills/local.md"]
        );
        assert_eq!(
            result["hashes"]["agent/skills/linked.md"],
            symlink_digest(&foreign)
        );
        assert_eq!(
            result["hashes"]["agent/skills/local.md"],
            sha256_hex(b"local")
        );
        assert_ne!(
            result["hashes"]["agent/skills/linked.md"],
            sha256_hex(b"foreign-secret-bytes")
        );
    }

    #[test]
    fn file_bytes_cannot_impersonate_a_symlink_identity() {
        let fixture = Fixture::new();
        let foreign = fixture.root.join("foreign-settings.json");
        fs::write(&foreign, b"foreign-secret-bytes").unwrap();
        unix_fs::symlink(&foreign, fixture.agent.join("settings.json")).unwrap();
        let linked = op_trust_hashes(&fixture.req()).unwrap();
        let link_hash = linked["hashes"]["agent/settings.json"].as_str().unwrap().to_string();
        assert!(link_hash.starts_with(SYMLINK_DIGEST_PREFIX));

        fs::remove_file(fixture.agent.join("settings.json")).unwrap();
        let mut impersonation = b"symlink\0".to_vec();
        impersonation.extend_from_slice(foreign.as_os_str().as_bytes());
        fs::write(fixture.agent.join("settings.json"), &impersonation).unwrap();
        let regular = op_trust_hashes(&fixture.req()).unwrap();
        let file_hash = regular["hashes"]["agent/settings.json"].as_str().unwrap();
        assert_ne!(file_hash, link_hash);
        assert!(!file_hash.starts_with(SYMLINK_DIGEST_PREFIX));
        assert_eq!(file_hash, hex_sha256(&impersonation));
    }

    #[test]
    fn dangling_symlink_is_still_a_complete_link_identity() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("missing-settings.json");
        unix_fs::symlink(&missing, fixture.agent.join("settings.json")).unwrap();
        let result = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(
            result["hashes"]["agent/settings.json"],
            symlink_digest(&missing)
        );
    }

    #[test]
    fn readlink_failure_fails_the_walk() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("missing-target");
        unix_fs::symlink(&missing, fixture.agent.join("settings.json")).unwrap();
        fs::write(&missing, b"temp").unwrap();
        // Replace the symlink path with a directory after creating a dangling
        // name collision: unlink the symlink and put a directory there, then
        // point hash_symlink at a path that is not a symlink.
        fs::remove_file(fixture.agent.join("settings.json")).unwrap();
        fs::create_dir(fixture.agent.join("settings.json")).unwrap();
        let error = hash_symlink(
            &fixture.agent.join("settings.json"),
            "agent/settings.json",
            &mut 0,
            &mut 0,
            &TrustBudget::production(),
        )
        .unwrap_err();
        assert!(
            error.contains("readlink"),
            "expected a readlink failure, got {error}"
        );
    }

    #[test]
    fn absent_roots_report_a_complete_empty_map() {
        let fixture = Fixture::new();
        let result = op_trust_hashes(&fixture.req()).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["hashes"], json!({}));
    }
}
