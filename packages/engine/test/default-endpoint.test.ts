import { afterEach, beforeEach, expect, test } from "bun:test";
import { customModelId, modelForTier } from "@agenteschat/providers";
import {
  autoModelFor,
  createCredential,
  defaultCredentials,
  listCredentials,
  liveKeyReach,
  orgAutoModels,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const net = { allowPrivate: false, resolveHost: async () => ["93.184.216.34"] };
const endpoint = () =>
  createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "custom",
      label: "lite llm",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai", baseURL: "https://gw.example.com/v1", models: [{ id: "m-1", check: "ok" }] },
    },
    { net },
  );

test("an endpoint key becomes the workspace default, and its provider's", async () => {
  const gateway = await endpoint();
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultCredentialId: gateway.id });
  expect(await defaultCredentials(f.db, f.org.id)).toEqual({
    legacy: gateway.id,
    perProvider: { custom: gateway.id },
  });
  const listed = await listCredentials(f.db, f.owner.id, f.org.id);
  expect(listed.find((k) => k.id === gateway.id)?.isDefault).toBe(true);
  expect(listed.find((k) => k.id === f.credential.id)?.isDefault).toBe(false);
});

test("a tier of Automático may name a model of any connected key, and only of a connected one", async () => {
  const gateway = await endpoint();
  const pinned = customModelId(gateway.id, "m-1");
  const claude = modelForTier("anthropic", "large") as string;
  // The line is the endpoint's (`custom`); the anthropic key of the fixture is connected too.
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { autoModels: { custom: { small: claude, medium: pinned } } });
  const tiers = (await orgAutoModels(f.db, f.org.id)).custom;
  expect(tiers).toEqual({ small: claude, medium: pinned });
  // The engine takes each pick as it is: the foreign one calls with its own key.
  const reach = await liveKeyReach(f.db, f.org.id);
  const line = { credentialId: gateway.id, models: [{ id: "m-1", check: "ok" as const }] };
  expect(autoModelFor("custom", "small", tiers, line, null, reach)).toBe(claude);
  expect(autoModelFor("custom", "medium", tiers, line, null, reach)).toBe(pinned);
  // No key of OpenAI's here: its model is refused.
  const openai = modelForTier("openai", "small") as string;
  await expect(
    updateOrgSettings(f.db, f.owner.id, f.org.id, { autoModels: { custom: { large: openai } } }),
  ).rejects.toBeInstanceOf(ValidationError);
});
