mod common;
use common::{CoreProcess, TempFixture, identity_json, wait_for_path};
use serde_json::json;
use std::{fs, time::Duration};
const DEADLINE: Duration = Duration::from_secs(10);

#[test]
fn rename_preserves_entries_replaced_on_either_side_of_the_syscall() {
    for stage in ["rename-before-syscall", "rename-after-syscall"] {
        let fixture = TempFixture::new("rename-race");
        let home = fixture.join("home");
        let root = fixture.join("root");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&root).unwrap();
        let source = root.join("source");
        fs::write(&source, b"original").unwrap();
        let ready = fixture.join("ready");
        let release = fixture.join("release");
        let mut core = CoreProcess::spawn(&home, fixture.path());
        let id = core
            .send(
                "promotion-bound-rename",
                json!({
                    "root": root, "rootIdentity": identity_json(&root),
                    "sourceComponents": ["source"], "destinationComponents": ["destination"],
                    "expectedIdentity": identity_json(&source),
                    "testHook": {"stage": stage, "readyPath": ready, "releasePath": release},
                }),
            )
            .unwrap();
        wait_for_path(&ready, DEADLINE);
        if stage == "rename-before-syscall" {
            fs::rename(&source, root.join("original-aside")).unwrap();
        }
        fs::write(&source, b"replacement").unwrap();
        fs::write(release, b"continue").unwrap();
        let result = core.recv(&id, DEADLINE).unwrap();
        assert_eq!(result["ok"], false, "{result}");
        if stage == "rename-before-syscall" {
            assert_eq!(fs::read(root.join("original-aside")).unwrap(), b"original");
            assert_eq!(fs::read(root.join("destination")).unwrap(), b"replacement");
        } else {
            assert_eq!(fs::read(&source).unwrap(), b"replacement");
            assert_eq!(fs::read(root.join("destination")).unwrap(), b"original");
        }
        core.shutdown();
    }
}

#[test]
fn rename_moves_files_directories_and_links_and_refuses_existing_destinations() {
    let fixture = TempFixture::new("rename-normal");
    let home = fixture.join("home");
    let root = fixture.join("root");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&root).unwrap();
    let mut core = CoreProcess::spawn(&home, fixture.path());
    for kind in ["file", "directory", "symlink"] {
        let source = root.join(kind);
        let dest = root.join(format!("{kind}-moved"));
        match kind {
            "directory" => fs::create_dir(&source).unwrap(),
            "symlink" => std::os::unix::fs::symlink("missing", &source).unwrap(),
            _ => fs::write(&source, b"bytes").unwrap(),
        }
        let request = json!({"root": root, "rootIdentity": identity_json(&root),
            "sourceComponents": [kind], "destinationComponents": [format!("{kind}-moved")],
            "expectedIdentity": identity_json(&source)});
        fs::write(&dest, b"do not replace").unwrap();
        let failed = core
            .request("promotion-bound-rename", request.clone(), DEADLINE)
            .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(fs::read(&dest).unwrap(), b"do not replace");
        fs::remove_file(&dest).unwrap();
        core.request_ok("promotion-bound-rename", request, DEADLINE)
            .unwrap();
        assert!(fs::symlink_metadata(&source).is_err());
        assert!(fs::symlink_metadata(&dest).is_ok());
    }
    core.shutdown();
}
