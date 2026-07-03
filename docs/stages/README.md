# ledger Learning Stages

Task + resource reference for building the ledger core CLI, one Rust concept
at a time. See `docs/ledger.md` for the original requirements and the
architecture/collaboration-model discussion for the full rationale behind the
ordering below.

**Collaboration model**: you write all the code. Before each stage, concepts
get primed in conversation (with the doc links collected here); after you
write it, it gets reviewed — correctness, idioms, borrow-checker issues — not
rewritten for you.

**How to use these files**: each stage file is a standalone checklist you can
work through independently of the chat history. Check items off as you go;
the "Resources" links are there for when a task doesn't make sense yet.

| # | Stage | Status |
|---|-------|--------|
| 1 | [Scaffold](01-scaffold.md) | Complete |
| 2 | [sessions.rs — pure session-collapsing algorithm](02-sessions.md) | Complete |
| 3 | [paths.rs — filesystem locations](03-paths.md) | Complete |
| 4 | [db.rs — SQLite storage](04-db.md) | Complete |
| 5 | [git.rs — shelling out to git](05-git.md) | Complete |
| 6 | [config.rs — .ledger.json](06-config.md) | Complete |
| 7 | [project.rs — identity resolution](07-project.md) | Complete |
| 8 | [errors.rs — never fail loudly](08-errors.md) | Complete |
| 9 | [cli.rs + commands/ — real implementations](09-commands.md) | Complete |
| 10 | [integration_init_hook.rs — end-to-end test](10-integration-test.md) | Complete |
| 11 | [Polish](11-polish.md) | Complete |
| 12 | [Cloud sync via Convex](12-cloud-sync.md) | Complete |
| 13 | [Neovim plugin (ledger.nvim)](13-nvim-plugin.md) | Complete |

## Sequencing note

This order is **not** build-dependency order — it's ordered for gradual
concept introduction: pure logic (no I/O) first, then increasingly risky
integration points (filesystem, SQLite, subprocesses, panics), and assembly
last. Stage 9 is where everything gets wired together, which is why it comes
so late despite `cli.rs` itself starting in Stage 1.
