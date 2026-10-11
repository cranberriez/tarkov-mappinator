# Real sample collection

Real samples are recorded in [the log evidence matrix](log-evidence.md), `logs/`, and `screenshots/filenames.json`. The screenshots include a user-confirmed PvE scav capture on Customs; only mode and map are independently supported by the corresponding logs. Do not manufacture game filenames or log formats.

## Screenshot evidence

1. Use Tarkov's configured in-game screenshot action during a raid. An OS screenshot may not contain the game's filename metadata.
2. Locate the resulting file, retaining its exact basename and extension. File contents are not needed for filename parsing.
3. Record game version, mode, map, approximate capture time/timezone, and a known facing direction if available.
4. Collect multiple facing directions and examples without position metadata when available.

The Windows Documents and Pictures locations can be redirected. Use the actual known-folder paths rather than assuming `C:\Users\<name>\Documents`.

## Log evidence

Use the main game's installation `Logs` directory, with its per-session timestamp/version subdirectories. Keep Arena, launcher, and Unity Player logs separate; their presence does not establish raid-state evidence.

Start with a small application-log excerpt spanning a known lifecycle transition. Review locally before copying: redact account/profile IDs, tokens, server addresses, private paths, and other identifiers. Use consistent replacements, preserving delimiters, line order, relative timing, and event structure. Do not blindly copy backend/network logs into tracked fixtures.

For each reviewed fixture, record its source log category, game version, mode/role if independently known, observed player action, sanitization applied, and which fields are actually supported. Collect loading, started, ended, and exited independently; unsupported transitions must remain unknown.

Also collect mid-raid startup, rotation, incomplete final records, and repeated records. These will establish ingestion/state tests after the event grammar is understood. Historical logs may help recover context; historical screenshots must not become current positions.

## Heading validation

Keep raw quaternion components in their original order. Verify component order, coordinate handedness, forward axis, heading zero, and direction of increasing heading against known-direction captures before adding a conversion formula.
