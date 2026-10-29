#!/usr/bin/env node
// CLI entry point. Commands arrive in WP 10 (specs/MISSION.md 6.3).
import { ConfxError } from "../session/index.js";

const error = new ConfxError("invalid_usage", "No commands are implemented yet.", { argument: null, reason: "not_implemented" });
process.stdout.write(`${JSON.stringify({ error: error.toJSON() })}\n`);
process.exitCode = 1;
