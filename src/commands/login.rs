use anyhow::Result;

use crate::cloud::auth;
use crate::{paths, settings};

/// `ledger login`: WorkOS device flow — print a code, wait for the user
/// to confirm it in a browser, store the resulting tokens.
pub fn run() -> Result<()> {
    let home = paths::ensure_ledger_home()?;
    let settings = settings::load_or_init(&home)?;

    let auth = auth::start_device_authorization(&settings)?;
    println!("To log in, open:\n");
    println!("    {}\n", auth.verification_uri_complete);
    println!(
        "or go to {} and enter the code {}",
        auth.verification_uri, auth.user_code
    );
    println!("\nWaiting for the browser confirmation...");

    let credentials = auth::poll_for_tokens(&settings, &auth)?;
    settings::save_credentials(&home, &credentials)?;
    println!("Logged in.");
    Ok(())
}
