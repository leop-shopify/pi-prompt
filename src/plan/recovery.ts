import { scanPlanBranchLocators, type PlanBranchEntry } from "./locator.js";
import type { PlanRepository, RecoveredPlanState } from "./repository.js";

export async function recoverPlanFromBranch(
  entries: readonly PlanBranchEntry[], repository: PlanRepository,
): Promise<RecoveredPlanState> {
  const scan = scanPlanBranchLocators(entries, repository.rootDir);
  return repository.recover(scan);
}
