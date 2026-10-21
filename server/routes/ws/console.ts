import { defineWebSocketHandler } from "h3";
import { ConsoleRelay } from "../../lib/agents/console";

// The dashboard's live agent log. See server/lib/agents/console.ts.
export default defineWebSocketHandler(ConsoleRelay.hooks());
