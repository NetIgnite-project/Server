import { defineWebSocketHandler } from "h3";
import { AgentGatewayRunner } from "../../lib/agents/gateway";

// Agent connections (ESP32 firmware, Linux agent). See server/lib/agents/protocol.ts.
export default defineWebSocketHandler(AgentGatewayRunner.hooks());
