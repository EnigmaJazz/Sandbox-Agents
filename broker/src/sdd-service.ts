import type { SddRuntimeExecutor } from "./sdd-runtime.ts";
import type { BrokerRequestEnvelope } from "./types.ts";
import { assertPayloadKeys, ValidationError } from "./validation.ts";

interface SddOpContext {
  sddRuntime: SddRuntimeExecutor;
}

type SddPayload = Record<string, unknown>;

function payloadOf(req: BrokerRequestEnvelope): SddPayload {
  assertPayloadKeys(req.operation, req.payload);
  return (req.payload ?? {}) as SddPayload;
}

/** Host-side SDD status; it deliberately has no worker/session dependency. */
export function buildSddStatusOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    if (typeof payload.projectDir !== "string") {
      throw new ValidationError("projectDir must be a string");
    }
    return ctx.sddRuntime.status(payload.projectDir);
  };
}

/** Host-side SDD attempt acquisition; only the fixed operation payload is accepted. */
export function buildSddAttemptAcquireOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    if (typeof payload.projectDir !== "string") {
      throw new ValidationError("projectDir must be a string");
    }
    return ctx.sddRuntime.attemptAcquire({
      projectRoot: payload.projectDir,
      change: payload.change as string,
      requestId: payload.requestId as string,
      workUnit: payload.workUnit as string,
      evidenceGoal: payload.evidenceGoal as string,
      maxAttempts: payload.maxAttempts as number,
      maxChangedLines: payload.maxChangedLines as number,
    });
  };
}
