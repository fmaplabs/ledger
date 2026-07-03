# Scaffold CLI tool

ledger is a tool for commit based time tracking for freelance software developers. It's conceptually similar to tools
like wakatime. 

In this session, we'll plan the architecture and implementation.

# Requirements

1. Tracks time working on a project/task based on git commits. Githooks?
2. ledger should have an editor integration plugin (neovim).
3. Times should be tracked locally via a lightweight sqlite database for offline time tracking.
4. I should be able to generate an invoice based on the hours worked.
5. I should be able to sync tracking between machines. This will most likely require using a cloud database that we sync
   to.
6. We will also build a GUI web app that can be used for invoice management
