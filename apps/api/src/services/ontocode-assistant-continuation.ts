import {
  ONTOCODE_COMMAND_POLICY,
  type OntoCodeHarnessJob,
} from "@agentic/contracts";
import {
  isOntoCodeHarnessAssistantAction,
  type OntoCodeAssistantPlan,
} from "./ontocode-assistant-planner";

type OntoCodeBuildContinuationJob = Pick<
  OntoCodeHarnessJob,
  "id" | "kind" | "status" | "buildExecutionId"
>;

/**
 * A waiting Build is already an active product interaction. It therefore has
 * priority over bootstrapping a new autonomous full-domain Build pipeline.
 */
export function hasWaitingOntoCodeBuildInteraction(
  jobs: ReadonlyArray<OntoCodeBuildContinuationJob>,
): boolean {
  return jobs.some(
    (job) => job.kind === "build" && job.status === "waiting_user",
  );
}

/**
 * Keep a reply to an unfinished Build inside that Build's stable OntoCode
 * execution.
 *
 * `patch_artifact` and `generate_package` both use the Build worker, so a model
 * can reasonably classify "repair/revalidate the draft" as the former. Once a
 * Build is waiting for the FDE, however, the distinction is no longer cosmetic:
 * only `generate_package` is the continuation command that carries the pending
 * interaction onto the same stable execution. Starting a second artifact edit
 * would either split the lifecycle or be rejected by the store.
 *
 * The server therefore owns this mapping. It changes neither the assistant's
 * visible explanation nor its evidence; it only converts a Build-kind execute
 * request into the exact continuation action while a Build is waiting.
 */
export function normalizeOntoCodeWaitingBuildContinuation(
  plan: OntoCodeAssistantPlan,
  jobs: ReadonlyArray<OntoCodeBuildContinuationJob>,
): OntoCodeAssistantPlan {
  if (
    plan.behavior !== "execute" ||
    !isOntoCodeHarnessAssistantAction(plan.action) ||
    ONTOCODE_COMMAND_POLICY[plan.action].jobKind !== "build" ||
    !hasWaitingOntoCodeBuildInteraction(jobs) ||
    plan.action === "generate_package"
  ) {
    return plan;
  }

  return {
    ...plan,
    action: "generate_package",
    recommendations: plan.recommendations.filter((recommendation) => {
      const action = recommendation.action;
      return !(
        action?.type === "execute" &&
        isOntoCodeHarnessAssistantAction(action.turnAction) &&
        ONTOCODE_COMMAND_POLICY[action.turnAction].jobKind === "build"
      );
    }),
    rationaleSummary:
      `${plan.rationaleSummary}；服务端已将本次修复绑定到等待中的同一 OntoCode Build 续跑。`.slice(
        0,
        1_000,
      ),
  };
}
