use clap::Parser;
use ledger::cli::{
    Cli,
    Commands::{Heartbeat, HookCommit, Init, Login, Logout, Report, Schema, Status, Sync},
};
use ledger::commands;

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Init { with_config } => commands::init::run(with_config),
        // heartbeat and hook-commit run silently: they always return () and
        // exit 0 — failures land in ~/.ledger/error.log instead.
        Heartbeat { file, write } => {
            commands::heartbeat::run(file, write);
            Ok(())
        }
        HookCommit => {
            commands::hook_commit::run();
            Ok(())
        }
        Report {
            project,
            since,
            until,
            idle_threshold_minutes,
        } => commands::report::run(project, since, until, idle_threshold_minutes),
        Schema => commands::schema::run(),
        Status { json } => commands::status::run(json),
        Login => commands::login::run(),
        Logout => commands::logout::run(),
        Sync { push_only } => commands::sync::run(push_only),
    }
}
