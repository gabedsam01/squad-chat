import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createDecisionJudge,
  createDecisionModel,
  createFakeJudge,
  createJevJudge,
  createLocalKeyWrapper,
  type DecisionModel,
  type JudgeRequest,
  judgeSeesImages,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

// Images are judged only by the installation's decision model, and only when it reads them (ADR 9006).
const image = { shot: { data: "AAAA", format: "png" as const } };
const request = (withImage: boolean): JudgeRequest => ({
  orgId: "o",
  kind: "k",
  state: { shot: "shot" },
  questions: { ok: { type: "noul", instructions: "ok?", criteria: { true: "t", false: "f" } } },
  ...(withImage ? { images: image } : {}),
});

describe("images and the judges (ADR 9006)", () => {
  test("Jev refuses images before any network call", async () => {
    let calls = 0;
    const judge = createJevJudge({
      key: { current: async () => "ts_key", usable: () => true } as never,
      gateway: { recordExternalUsage: async () => {} } as never,
      fetch: (async () => {
        calls++;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await expect(judge.ask(request(true))).rejects.toThrow("no images");
    expect(calls).toBe(0);
    expect(judgeSeesImages(request(true))).toBe(true);
    expect(judgeSeesImages(request(false))).toBe(false);
  });

  const modelOf = (inputs: string[]) =>
    ({
      usable: () => true,
      current: async () => ({
        provider: "local",
        model: "m",
        baseURL: "http://x",
        timeoutMs: 1000,
        capabilities: { inputs },
      }),
      report: () => {},
    }) as unknown as DecisionModel;
  const sent = async (inputs: string[]) => {
    const bodies: Record<string, unknown>[] = [];
    const fallback = createFakeJudge();
    const judge = createDecisionJudge({
      model: modelOf(inputs),
      fallback,
      gateway: { recordExternalUsage: async () => {} } as never,
      http: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ model: "m", answers: { ok: { type: "noul", noul: 1 } }, usage: {} });
      }) as unknown as typeof fetch,
    });
    await judge.ask(request(true));
    return { bodies, fallback };
  };

  test("an image goes to a decision model that reads images", async () => {
    const { bodies, fallback } = await sent(["text", "image"]);
    expect(bodies).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
  });

  test("an image goes to the fallback, not the model, when it reads text only", async () => {
    const { bodies, fallback } = await sent(["text"]);
    expect(bodies).toHaveLength(0);
    expect(fallback.calls).toHaveLength(1);
  });
});

describe("DecisionModel.seesImages", () => {
  let f: Fixture;
  afterEach(() => f?.close?.());
  test("on and reading images, and nothing else", async () => {
    f = await setup();
    const wrapper = createLocalKeyWrapper(SECRET);
    const read = async () => {
      const model = createDecisionModel({ db: f.db, keyWrapper: wrapper, keyWrappers: [wrapper] });
      await model.ready();
      return model.seesImages();
    };
    expect(await read()).toBe(false);
    const row = { id: "default", provider: "local", model: "m", baseURL: "http://x" };
    await f.db
      .insert(schema.instanceDecisionModel)
      .values({ ...row, enabled: true, capabilities: { inputs: ["text"] } });
    expect(await read()).toBe(false);
    await f.db.update(schema.instanceDecisionModel).set({ capabilities: { inputs: ["text", "image"] } });
    expect(await read()).toBe(true);
    await f.db.update(schema.instanceDecisionModel).set({ enabled: false });
    expect(await read()).toBe(false);
  });
});

describe("DecisionModel keys (ADR 9001 addendum)", () => {
  let f: Fixture;
  afterEach(() => f?.close?.());
  test("each provider keeps its key: turning one on again takes none, and removing one keeps the others", async () => {
    f = await setup();
    const wrapper = createLocalKeyWrapper(SECRET);
    const model = createDecisionModel({ db: f.db, keyWrapper: wrapper, keyWrappers: [wrapper] });
    await model.ready();
    const user = f.owner.id;
    await model.save({ enabled: true, provider: "gemini", model: "gemini-decision-1", apiKey: "AQ.gemini-1111" }, user);
    await model.save({ enabled: true, provider: "openai", model: "gpt-6-luna", apiKey: "sk-openai-2222" }, user);
    // Jev: the switch off, both keys kept.
    expect((await model.save({ enabled: false }, user)).saved).toEqual([
      { provider: "gemini", hint: "1111" },
      { provider: "openai", hint: "2222" },
    ]);
    const back = await model.save({ enabled: true, provider: "gemini", model: "gemini-decision-1" }, user);
    expect(back.hint).toBe("1111");
    await f.db.update(schema.instanceDecisionModel).set({ enabled: true });
    const fresh = createDecisionModel({ db: f.db, keyWrapper: wrapper, keyWrappers: [wrapper] });
    await fresh.ready();
    expect((await fresh.current())?.apiKey).toBe("AQ.gemini-1111");
    const gone = await fresh.remove(user);
    expect(gone.enabled).toBe(false);
    expect(gone.saved).toEqual([{ provider: "openai", hint: "2222" }]);
    expect((await fresh.save({ enabled: true, provider: "gemini", model: "gemini-decision-1" }, user)).hint).toBeNull();
  });
});
