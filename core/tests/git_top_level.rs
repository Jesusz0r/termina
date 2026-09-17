//! #259: git-top-level must not collapse a corrupt repo to null.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};

use common::{CoreProcess, TempFixture};

const DEADLINE: Duration = Duration::from_secs(10);

fn git_env(home: &Path, tmp: &Path) -> Vec<(String, String)> {
    vec![
        (
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        ),
        ("HOME".to_string(), home.to_str().unwrap().to_string()),
        ("TMPDIR".to_string(), tmp.to_str().unwrap().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ]
}

struct TopLevelHarness {
    fixture: TempFixture,
    home: PathBuf,
    core: CoreProcess,
}

impl TopLevelHarness {
    fn new(prefix: &str) -> Self {
        let fixture = TempFixture::new(prefix);
        let home = fixture.join("home");
        fs::create_dir_all(&home).expect("create home");
        let core = CoreProcess::spawn(&home, fixture.path());
        Self {
            fixture,
            home,
            core,
        }
    }

    fn request(&mut self, root: &Path) -> Value {
        self.core
            .request(
                "git-top-level",
                json!({ "root": root.to_str().expect("root is UTF-8") }),
                DEADLINE,
            )
            .expect("git-top-level response")
    }

    fn shutdown(&mut self) {
        self.core.shutdown();
    }
}

#[test]
fn missing_repo_returns_null_root() {
    let mut harness = TopLevelHarness::new("top-missing");
    let folder = harness.fixture.join("empty");
    fs::create_dir_all(&folder).expect("create empty folder");
    let response = harness.request(&folder);
    assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
    assert!(response.get("root").unwrap().is_null());
    harness.shutdown();
}

#[test]
fn valid_repo_returns_workdir() {
    let mut harness = TopLevelHarness::new("top-valid");
    let source = harness.fixture.join("source");
    fs::create_dir_all(&source).expect("create source");
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .arg(&source)
        .envs(git_env(&harness.home, harness.fixture.path()))
        .status()
        .expect("git init");
    assert!(status.success(), "git init failed");
    let response = harness.request(&source);
    assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
    let root = response.get("root").and_then(Value::as_str).expect("root");
    let expected = fs::canonicalize(&source).expect("canonicalize source");
    assert_eq!(Path::new(root), expected.as_path());
    harness.shutdown();
}

#[test]
fn unreadable_git_dir_is_an_error() {
    let mut harness = TopLevelHarness::new("top-unreadable");
    let source = harness.fixture.join("source");
    fs::create_dir_all(&source).expect("create source");
    // A present but malformed `.git` gitfile is not "repo absent". git2
    // reports GenericError, which must surface instead of collapsing to null.
    fs::write(source.join(".git"), "this is not a gitdir pointer\n")
        .expect("write malformed gitfile");
    let response = harness.request(&source);
    assert_eq!(
        response.get("ok").and_then(Value::as_bool),
        Some(false),
        "corrupt .git must not collapse to null: {response}"
    );
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .expect("error");
    assert!(
        error.contains("the Git repository could not be opened"),
        "expected distinguishable open error, got {error}"
    );
    harness.shutdown();
}

#[test]
fn uncanonical_workdir_is_an_error() {
    let mut harness = TopLevelHarness::new("top-uncanonical-wt");
    let gitdir = harness.fixture.join("gitdir");
    let dangling = harness.fixture.join("dangling-work");
    std::os::unix::fs::symlink("missing-target", &dangling).expect("dangling workdir symlink");
    let status = Command::new("git")
        .args(["init", "--bare", "--quiet"])
        .arg(&gitdir)
        .envs(git_env(&harness.home, harness.fixture.path()))
        .status()
        .expect("git init --bare");
    assert!(status.success(), "git init --bare failed");
    let status = Command::new("git")
        .args(["-C"])
        .arg(&gitdir)
        .args(["config", "core.bare", "false"])
        .envs(git_env(&harness.home, harness.fixture.path()))
        .status()
        .expect("git config core.bare");
    assert!(status.success(), "git config core.bare failed");
    let status = Command::new("git")
        .args(["-C"])
        .arg(&gitdir)
        .args([
            "config",
            "core.worktree",
            dangling.to_str().expect("dangling path is UTF-8"),
        ])
        .envs(git_env(&harness.home, harness.fixture.path()))
        .status()
        .expect("git config core.worktree");
    assert!(status.success(), "git config core.worktree failed");
    let response = harness.request(&gitdir);
    assert_eq!(
        response.get("ok").and_then(Value::as_bool),
        Some(false),
        "uncanonical workdir must not be forged as a root: {response}"
    );
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .expect("error");
    assert!(
        error.contains("the Git workdir could not be canonicalized")
            || error.contains("the Git repository has no workdir")
            || error.contains("the Git repository could not be opened"),
        "expected workdir/open error, got {error}"
    );
    harness.shutdown();
}
