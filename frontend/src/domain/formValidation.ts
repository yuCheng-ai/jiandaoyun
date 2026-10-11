import type { FormSchema, FormValues } from "@platform/contracts";
import { formValidationResults as evaluateRules } from "@platform/contracts";
import { displayValue, resolveChoices } from "./relations";
import { isFieldVisible } from "./form";
import type { WorkspaceData } from "./workspace";
export { messageReferences, validationReferences, formValidationErrors, formulaLabel, changedValidationRules } from "@platform/contracts";
export type { FormValidationIssue } from "@platform/contracts";

/** Local directory and dynamic choices stay in the local runtime adapter. */
export function formValidationResults(schema: FormSchema, values: FormValues, context: {
  data?: WorkspaceData;
  displaySchema?: FormSchema;
  ruleIds?: ReadonlySet<string>;
} = {}) {
  return evaluateRules(schema, values, {
    displaySchema: context.displaySchema,
    ruleIds: context.ruleIds,
    visible: isFieldVisible,
    ...(context.data ? {
      options: field => resolveChoices(field, context.data!, values, schema.fields),
      display: (field, value) => displayValue(field, value, context.data!),
    } : {}),
  });
}
export function blockingFormValidation(schema: FormSchema, values: FormValues, context: Parameters<typeof formValidationResults>[2] = {}) {
  return formValidationResults(schema, values, context).filter(issue => issue.mode === "block").map(issue => issue.message);
}
