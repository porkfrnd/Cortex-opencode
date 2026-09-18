---
description: Run Cortex autonomous execution for an objective
agent: cortex
---

Run the Cortex autonomous pipeline for this objective: $ARGUMENTS

Drive every stage through the cortex_* tools in order (start → recall →
discover → goals → plan → dispatch → rehearse → implement → gauntlet →
remediate/verify → learn → finish). You own the objective until `finish`
returns its verdict. Do not declare completion early. Keep output lean;
use cortex_status for progress.
