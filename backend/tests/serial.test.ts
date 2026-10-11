import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSerialSettings,
  separateFormSchema,
  type FormSchema,
} from "@platform/contracts";
import { field, schema } from "./helpers";
import { parseSchema } from "../src/schema";
import { parseModel } from "../src/page-schema";

test("unimplemented server serial execution cannot be silently accepted as ordinary metadata", () => {
  assert.throws(
    () =>
      parseSchema(
        schema(
          field("s", "serial", { serial: defaultSerialSettings("counter") }),
        ),
      ),
    /暂不支持服务端执行/,
  );
  const dormant = schema(
    field("name", "text", { serial: defaultSerialSettings("counter") }),
  );
  assert.throws(() => parseSchema(dormant), /暂未接通的规则/);
  assert.throws(
    () =>
      parseModel(separateFormSchema(dormant as unknown as FormSchema).model),
    /暂未接通的规则/,
  );
});
