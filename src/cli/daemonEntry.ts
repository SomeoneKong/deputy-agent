/**
 * host daemon entry script (invoked via CLI detached spawn / `--foreground` import).
 *
 * argv: <projectRoot> <taskId>. Assembles a production DaemonConfig (provider runtime + model + isolation,
 * via buildProductionDaemonConfig) -> runDaemon -> returns the host exit code. As a process wrapper:
 * parse argv -> run the host main loop -> process.exit(host exit code).
 */
import { buildTaskCapsulePaths } from "../shared/paths.js";
import { HostExitCode } from "../host/daemon.js";
import { tasksRootOf } from "./projectRoot.js";
import { buildProductionDaemonConfig, loadManifestRoleBindings, runDaemon } from "./productionHost.js";

export async function daemonMain(argv: ReadonlyArray<string>): Promise<number> {
  const projectRoot = argv[0];
  const taskId = argv[1];
  if (projectRoot === undefined || taskId === undefined) {
    process.stderr.write("usage: daemonEntry <projectRoot> <taskId>\n");
    return HostExitCode.Fatal;
  }
  let paths;
  try {
    paths = buildTaskCapsulePaths(tasksRootOf(projectRoot), taskId);
  } catch (err) {
    process.stderr.write(`invalid task path: ${(err as Error).message}\n`);
    return HostExitCode.Fatal;
  }

  // per-task provider selection is persisted in manifest.roleBindings; load failure is fail-soft.
  const roleBindings = await loadManifestRoleBindings(paths);
  const result = await runDaemon(buildProductionDaemonConfig(paths, projectRoot, roleBindings));
  process.stderr.write(`host daemon exit: code=${result.exitCode} reason=${result.reason}\n`);
  return result.exitCode;
}

// When run directly as a script (detached spawn): parse process.argv then exit.
// Handles both production .js and dev-time tsx running .ts (argv[1] is the entry script's absolute path).
const invokedDirectly =
  process.argv[1] !== undefined && /[\\/]daemonEntry\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  daemonMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`daemon fatal: ${(err as Error).message}\n`);
      process.exit(HostExitCode.Fatal);
    });
}
