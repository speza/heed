import { AmpRuntimeAdapter } from "./amp.ts";
import { HerdrRuntimeAdapter } from "./herdr.ts";
import { MockApiRuntimeAdapter } from "./mock-runtime.ts";
import { RuntimeGateway } from "./runtime-gateway.ts";

export function createRuntimeGateway(): RuntimeGateway {
  return new RuntimeGateway([
    new HerdrRuntimeAdapter(),
    ...(process.env.HEED_ENABLE_AMP_RUNTIME === "1" ? [new AmpRuntimeAdapter()] : []),
    ...(process.env.HEED_ENABLE_MOCK_RUNTIME === "1" ? [new MockApiRuntimeAdapter()] : []),
  ]);
}
