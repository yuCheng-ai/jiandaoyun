// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  customColorStorageKey,
  readCustomColors,
  rememberCustomColor,
} from "../src/repositories/customColors";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("malformed or unsafe stored preferences cannot become selectable field colors", () => {
  const key = customColorStorageKey("local:one");
  for (const value of ["broken", "null", '{"color":"#123456"}']) {
    localStorage.setItem(key, value);
    expect(readCustomColors("local:one")).toEqual([]);
  }
  localStorage.setItem(
    key,
    JSON.stringify([
      null,
      42,
      "url(https://invalid.example)",
      "#123",
      "#AABBCC",
      "#aabbcc",
      "#000000",
    ]),
  );
  expect(readCustomColors("local:one")).toEqual(["#aabbcc", "#000000"]);
});

it("retains the latest other-page preferences without changing another member or business storage", () => {
  const business = '{"unchanged":true}';
  localStorage.setItem("workflow-studio-workspace-v1", business);
  rememberCustomColor("local:first", "#123456");
  rememberCustomColor("local:second", "#abcdef");
  rememberCustomColor("local:first", "#2468ac");
  expect(rememberCustomColor("local:first", "#112233")).toEqual([
    "#112233",
    "#2468ac",
    "#123456",
  ]);
  expect(readCustomColors("local:second")).toEqual(["#abcdef"]);
  expect(localStorage.getItem("workflow-studio-workspace-v1")).toBe(business);
});

it("unavailable preference storage does not throw or prevent the caller retaining its colors", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("read unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("write unavailable");
  });
  expect(readCustomColors("local:first")).toEqual([]);
  expect(rememberCustomColor("local:first", "#000000")).toEqual(["#000000"]);
  expect(rememberCustomColor("", "#000000")).toEqual(["#000000"]);
});
