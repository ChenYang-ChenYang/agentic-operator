/**
 * @agentic/tools/control — deterministic workflow control tools (no I/O,
 * no decisions): the ontology compiler wires them into generated manifests
 * where a model's honest "cannot proceed" report must become a failed run.
 */
export {
  fail,
  ControlFailError,
  CONTROL_FAIL_TOOL,
  CONTROL_FAIL_DEFAULT_CODE,
  CONTROL_FAIL_KIND,
} from "./fail";
