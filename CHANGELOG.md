# Changelog

## Alpha Radar Pro — Robinhood Edition

### v5.3 — Robinhood Universe (layer 1 of the Pro upgrade)
- **Robinhood-only universe**, driven by a single config file `server/src/config/robinhoodUniverse.js` (edit one list to change coverage). 31 coins, each mapped to one of 9 categories.
- Universe builder filters every scan/rank to the Robinhood allowlist and tags each coin with its `category`. Env toggle `ROBINHOOD_ONLY` (default true).
- Dashboard shows the **"Robinhood Crypto Universe"** label, a **category filter bar** (Store of Value, Smart Contracts, Payments, DeFi, Infrastructure, Meme Coins, Layer 2, AI / Compute, Other), and a category chip on the selected coin.
- Demo dataset expanded to span all categories so demo mode is representative.
- No changes to scoring or ranking. Additive only. Unit-tested (config filter + categorization).

### Earlier (already in the system, reused by the Pro edition)
- v5.2 Failure Learning — rule-based "why it lost" classifier (13 reasons), rollups, Trade Replay + Performance + Pattern integrations.
- v5.1 Pattern Library — hierarchical patterns, Wilson LBs, shrinkage, strength, regime memory, dashboard, similar-setup matching.
- Radar Learn (Pass 1/2), System Performance, Trade Replay, deep-history backfill, live charts, mobile/overflow hardening.
