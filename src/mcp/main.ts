// Launches the MCP server on stdio (spec §10, track 02).
//
// Register with an MCP client as:
//   { "command": "npx", "args": ["tsx", "src/mcp/main.ts"], "cwd": "<this repo>" }
//
// Needs the FalkorDB container up and the repo's graph already ingested.

import { serve } from "./server.ts";

await serve();
