import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  generateWebhookCredential,
  parseWebhookCredentials,
  webhookSignature,
  buildSignedWebhookRequest,
  verifyWebhookRequest,
  checkWebhookConnection,
} from "../src/domain/webhookSecurity";
import {
  newWebhook,
  runWebhook,
  validateWebhook,
} from "../src/domain/extensions";
import { useWorkspaceStore } from "../src/stores/workspace";
import { LocalWorkspaceRepository } from "../src/repositories/workspaceRepository";

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((k) => memory.get(k) || null),
    setItem: vi.fn((k, v) => memory.set(k, v)),
  });
  setActivePinia(createPinia());
});
describe("webhook secret lifecycle and protocol", () => {
  it("generates independent local secrets and rejects malformed stored material", () => {
    const a = generateWebhookCredential(),
      b = generateWebhookCredential();
    expect(a.secret).toMatch(/^demo_[a-f0-9]{64}$/);
    expect(a.secret).not.toBe(b.secret);
    expect(
      parseWebhookCredentials([a, a, { ...b, secret: "invalid" }]),
    ).toEqual([a]);
  });
  it("matches the documented SHA-1 concatenation with a fixed independent vector", async () => {
    expect(
      await webhookSignature("nonce-1", '{"a":1}', "test-secret", "1700000000"),
    ).toBe("f436ea7f8cb4d3c44b7f39251ea18030177d278c");
  });
  it("verifies the original request body and rejects changed body, nonce or secret", async () => {
    const request = await buildSignedWebhookRequest(
      "https://example.com/hook?tenant=1",
      '{"a":1}',
      "test-secret",
      "nonce-1",
      "1700000000",
    );
    expect(await verifyWebhookRequest(request, "test-secret")).toBe(true);
    expect(
      await verifyWebhookRequest(
        { ...request, body: '{ "a": 1 }' },
        "test-secret",
      ),
    ).toBe(false);
    expect(
      await verifyWebhookRequest(
        { ...request, url: request.url.replace("nonce-1", "nonce-2") },
        "test-secret",
      ),
    ).toBe(false);
    expect(await verifyWebhookRequest(request, "wrong")).toBe(false);
    expect(new URL(request.url).searchParams.get("tenant")).toBe("1");
    expect(JSON.stringify(request)).not.toContain("test-secret");
  });
  it("reports local success, mismatched signatures and timeout without network traffic", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const c = generateWebhookCredential();
    expect(
      (await checkWebhookConnection("https://example.com", "{}", c, "success"))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await checkWebhookConnection(
          "https://example.com",
          "{}",
          c,
          "signature",
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await checkWebhookConnection("https://example.com", "{}", c, "timeout"))
        .status,
    ).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("persists a generated secret separately and retains old version references on regeneration", async () => {
    const store = useWorkspaceStore(),
      form = store.openForm("employee")!,
      c = (await store.createWebhookCredential())!;
    const config = newWebhook();
    Object.assign(config, {
      name: "test",
      url: "https://example.com",
      fieldIds: [form.schema.fields[0]!.id],
      credentialRef: c.id,
      enabled: true,
    });
    expect(await store.saveWebhook(form.id, config)).toBe(true);
    expect(await store.publishForm(form.id)).toBe(true);
    const next = (await store.createWebhookCredential())!;
    config.credentialRef = next.id;
    await store.saveWebhook(form.id, config);
    expect(form.published!.extensions!.webhooks[0]!.credentialRef).toBe(c.id);
    const restored = new LocalWorkspaceRepository().load()!;
    expect(
      restored.webhookCredentials!.find((v) => v.id === c.id)?.secret,
    ).toBe(c.secret);
    const run = runWebhook(config, form.schema, {}, "data_create", store.data);
    expect(run.status).toBe("success");
    expect(JSON.stringify(run)).not.toContain(next.secret);
  });
  it("requires generation for legacy selectors and fails safely on missing credentials or storage errors", async () => {
    const store = useWorkspaceStore(),
      form = store.openForm("employee")!,
      config = newWebhook();
    config.credentialRef = "demo-signature";
    expect(
      validateWebhook(config, form.schema).some(
        (i) => i.target === "credential",
      ),
    ).toBe(true);
    config.credentialRef = "removed";
    Object.assign(config, {
      name: "test",
      url: "https://example.com",
      fieldIds: [form.schema.fields[0]!.id],
    });
    expect(
      runWebhook(config, form.schema, {}, "data_create", store.data).status,
    ).toBe("failed");
    const previous = store.data.webhookCredentials;
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw Error("quota");
    });
    expect(await store.createWebhookCredential()).toBeUndefined();
    expect(store.data.webhookCredentials).toBe(previous);
  });
});
