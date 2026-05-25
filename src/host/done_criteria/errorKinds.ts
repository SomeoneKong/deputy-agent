/**
 * done_criteria subsystem errorKind set.
 *
 * Field names camelCase / string values snake_case. Defined locally in the done_criteria module
 * (a done_criteria-local namespace, not the shared host error kinds).
 *
 * Two usage subsets:
 * - `CheckOutcome.errorKind` (check `result=error` level): path_escape / check_io_error / yaml_parse_error /
 *   interpreter_not_allowed / interpreter_not_found / script_timeout / script_io_error
 * - `OutcomeSummary.errorKind` (evaluator / load / validate level `overall=error`): file_not_found /
 *   file_io_error / yaml_parse_error / schema_invalid / path_escape / evaluator_internal_error
 *
 * The two subsets may share tokens (path_escape / yaml_parse_error span both levels); result/overall decides which field is filled.
 */

export type DoneCriteriaErrorKind =
  | "done_criteria_file_not_found"
  | "done_criteria_file_io_error"
  | "done_criteria_yaml_parse_error"
  | "done_criteria_schema_invalid"
  | "done_criteria_evaluator_internal_error"
  | "done_criteria_path_escape"
  | "done_criteria_check_io_error"
  | "done_criteria_interpreter_not_allowed"
  | "done_criteria_interpreter_not_found"
  | "done_criteria_script_timeout"
  | "done_criteria_script_io_error";

export const DoneCriteriaErrorKind = {
  fileNotFound: "done_criteria_file_not_found",
  fileIoError: "done_criteria_file_io_error",
  yamlParseError: "done_criteria_yaml_parse_error",
  schemaInvalid: "done_criteria_schema_invalid",
  evaluatorInternalError: "done_criteria_evaluator_internal_error",
  pathEscape: "done_criteria_path_escape",
  checkIoError: "done_criteria_check_io_error",
  interpreterNotAllowed: "done_criteria_interpreter_not_allowed",
  interpreterNotFound: "done_criteria_interpreter_not_found",
  scriptTimeout: "done_criteria_script_timeout",
  scriptIoError: "done_criteria_script_io_error",
} as const satisfies Record<string, DoneCriteriaErrorKind>;
