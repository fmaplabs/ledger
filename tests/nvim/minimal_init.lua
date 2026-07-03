-- Minimal rc for the headless smoke tests: the repo root on rtp (so the
-- plugin loads exactly as installed) and the bash shim shadowing the real
-- binary on PATH.
local here = vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))
local root = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(root)
vim.env.PATH = here .. "/bin:" .. vim.env.PATH
vim.env.LEDGER_SHIM_LOG = vim.fn.tempname()
