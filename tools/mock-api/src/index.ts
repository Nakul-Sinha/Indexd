import { app } from "./app.ts";

/**
 * Entry point. The app itself lives in app.ts so tests can drive it in process
 * with app.handle(new Request(...)) instead of binding a port.
 */

const port = Number(process.env.MOCK_API_PORT ?? 4010);
app.listen(port);

console.log(`mock api listening on http://localhost:${port}`);
console.log("  servers:       srv_7f2 (yours), srv_a19 (not yours, for scoping tests)");
console.log("  scenarios:     ?scenario=happy|stall|abort_at_verifying|fail_at_building");
