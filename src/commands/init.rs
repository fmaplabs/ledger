use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result};

use crate::{config, git};

const HOOK_INVOCATION: &str = "ledger hook-commit";
const HOOK_SCRIPT: &str = "#!/bin/sh\n# Installed by `ledger init`.\nledger hook-commit\n";
const SCHEMA_FILE_NAME: &str = ".ledger.schema.json";

/// Install the post-commit hook (and, with `--with-config`, scaffold
/// `.ledger.json` + its schema). Unlike heartbeat/hook-commit this is an
/// interactive command — failures should be loud, so it returns `Result`.
pub fn run(with_config: bool) -> Result<()> {
    let cwd = env::current_dir().context("resolving current directory")?;
    let repo_root =
        git::repo_root(&cwd).context("`ledger init` must be run inside a git repository")?;

    install_hook(&cwd)?;
    if with_config {
        scaffold_config(&repo_root)?;
    }
    Ok(())
}

fn install_hook(cwd: &Path) -> Result<()> {
    let hooks_dir = git::hooks_dir(cwd)?;
    fs::create_dir_all(&hooks_dir)
        .with_context(|| format!("creating hooks dir {}", hooks_dir.display()))?;
    let hook_path = hooks_dir.join("post-commit");

    if hook_path.exists() {
        let contents = fs::read_to_string(&hook_path)
            .with_context(|| format!("reading existing hook {}", hook_path.display()))?;
        if contents.contains(HOOK_INVOCATION) {
            println!(
                "post-commit hook already calls ledger — leaving {} untouched",
                hook_path.display()
            );
            return Ok(());
        }
        // Someone else's hook lives here: append ours rather than clobber it.
        let mut file = OpenOptions::new()
            .append(true)
            .open(&hook_path)
            .with_context(|| format!("opening {} to append", hook_path.display()))?;
        let separator = if contents.ends_with('\n') { "" } else { "\n" };
        write!(
            file,
            "{separator}\n# Added by `ledger init`.\n{HOOK_INVOCATION}\n"
        )
        .context("appending to existing post-commit hook")?;
        println!(
            "appended ledger to existing post-commit hook at {}",
            hook_path.display()
        );
    } else {
        fs::write(&hook_path, HOOK_SCRIPT)
            .with_context(|| format!("writing hook {}", hook_path.display()))?;
        println!("installed post-commit hook at {}", hook_path.display());
    }

    make_executable(&hook_path)?;
    Ok(())
}

fn make_executable(path: &Path) -> Result<()> {
    let mut perms = fs::metadata(path)
        .with_context(|| format!("reading permissions of {}", path.display()))?
        .permissions();
    perms.set_mode(perms.mode() | 0o111); // add +x, keep everything else
    fs::set_permissions(path, perms)
        .with_context(|| format!("marking {} executable", path.display()))?;
    Ok(())
}

fn scaffold_config(repo_root: &Path) -> Result<()> {
    // The schema is generated output — always safe to (re)write.
    let schema_path = repo_root.join(SCHEMA_FILE_NAME);
    let schema = schemars::schema_for!(config::ProjectConfig);
    fs::write(
        &schema_path,
        format!("{}\n", serde_json::to_string_pretty(&schema)?),
    )
    .with_context(|| format!("writing {}", schema_path.display()))?;
    println!("wrote {}", schema_path.display());

    // The config is user data — never overwrite an existing one.
    let config_path = repo_root.join(config::CONFIG_FILE_NAME);
    if config_path.exists() {
        println!("{} already exists — leaving it untouched", config_path.display());
        return Ok(());
    }
    let project_name = repo_root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .context("repo root has no directory name")?;
    let scaffold = serde_json::json!({
        "$schema": format!("./{SCHEMA_FILE_NAME}"),
        "project": project_name,
        "idleThresholdMinutes": config::DEFAULT_IDLE_THRESHOLD_MINUTES,
    });
    fs::write(
        &config_path,
        format!("{}\n", serde_json::to_string_pretty(&scaffold)?),
    )
    .with_context(|| format!("writing {}", config_path.display()))?;
    println!("wrote {}", config_path.display());
    Ok(())
}
