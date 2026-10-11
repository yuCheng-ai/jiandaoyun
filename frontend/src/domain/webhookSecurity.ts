import { uid } from "./form";

export interface WebhookCredential {
  id: string;
  mode: "local-demo";
  secret: string;
  createdAt: string;
}
export interface SignedWebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export type ConnectionScenario = "success" | "signature" | "timeout";
export interface ConnectionCheck {
  status: "success" | "failed";
  message: string;
  request: SignedWebhookRequest;
  statusCode?: number;
}

export function generateWebhookCredential(): WebhookCredential {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    id: uid("credential"),
    mode: "local-demo",
    secret:
      "demo_" +
      Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    createdAt: new Date().toISOString(),
  };
}
export function parseWebhookCredentials(raw: unknown): WebhookCredential[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw
    .filter((c) => {
      if (
        !c ||
        typeof c.id !== "string" ||
        ids.has(c.id) ||
        c.mode !== "local-demo" ||
        !/^demo_[a-f0-9]{64}$/.test(c.secret)
      )
        return false;
      ids.add(c.id);
      return true;
    })
    .map((c) => ({
      id: c.id,
      mode: "local-demo",
      secret: c.secret,
      createdAt: String(c.createdAt || ""),
    }));
}
/** Jiandaoyun's documented compatibility algorithm; raw payload bytes must not be reserialized. */
export async function webhookSignature(
  nonce: string,
  rawBody: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    [nonce, rawBody, secret, timestamp].join(":"),
  );
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function buildSignedWebhookRequest(
  url: string,
  rawBody: string,
  secret: string,
  nonce: string = crypto.randomUUID(),
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): Promise<SignedWebhookRequest> {
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    throw Error("请输入有效的 HTTP 或 HTTPS 地址");
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("timestamp", timestamp);
  target.hash = "";
  return {
    url: target.toString(),
    body: rawBody,
    headers: {
      "Content-Type": "application/json",
      "X-JDY-DeliverId": crypto.randomUUID(),
      "X-JDY-Signature": await webhookSignature(
        nonce,
        rawBody,
        secret,
        timestamp,
      ),
    },
  };
}
export async function verifyWebhookRequest(
  request: SignedWebhookRequest,
  secret: string,
): Promise<boolean> {
  const url = new URL(request.url),
    nonce = url.searchParams.get("nonce"),
    timestamp = url.searchParams.get("timestamp");
  if (!nonce || !timestamp) return false;
  const expected = await webhookSignature(
    nonce,
    request.body,
    secret,
    timestamp,
  );
  return expected === request.headers["X-JDY-Signature"];
}
/** Exercises the signing/verification contract locally. Never calls fetch. */
export async function checkWebhookConnection(
  url: string,
  rawBody: string,
  credential: WebhookCredential,
  scenario: ConnectionScenario,
): Promise<ConnectionCheck> {
  const request = await buildSignedWebhookRequest(
    url,
    rawBody,
    credential.secret,
  );
  if (scenario === "timeout")
    return {
      status: "failed",
      message:
        "模拟接收端超时。请检查服务可达性与响应耗时；本次未发起网络连接。",
      request,
    };
  const valid = await verifyWebhookRequest(
    request,
    scenario === "signature"
      ? credential.secret + "-different"
      : credential.secret,
  );
  return valid
    ? {
        status: "success",
        message:
          "本地签名与验签通过，模拟接收端返回 HTTP 200。服务器真实连通性尚未检测。",
        request,
        statusCode: 200,
      }
    : {
        status: "failed",
        message:
          "模拟验签失败（HTTP 401）。请确保接收端使用相同 Secret，并按原始请求体计算签名。",
        request,
        statusCode: 401,
      };
}
