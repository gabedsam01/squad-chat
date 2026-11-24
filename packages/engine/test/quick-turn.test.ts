import { describe, expect, test } from "bun:test";
import { isQuickCleanReply, isQuickGreeting } from "../src/quick-turn";

describe("isQuickGreeting", () => {
  test("accepts pure greetings and acknowledgements in PT/EN/ES", () => {
    for (const msg of [
      "oi",
      "Oi!",
      "olá",
      "bom dia!",
      "@bot oi",
      '@"João Silva" @bot olá!',
      "oi, tudo bem?",
      "valeu!",
      "obrigado",
      "bom dia",
      "hi",
      "hello!",
      "thanks",
      "hey there",
      "hola",
      "oi 👋",
    ]) {
      expect(isQuickGreeting(msg)).toBe(true);
    }
  });

  test("rejects approvals that may answer an agent question", () => {
    for (const msg of ["ok", "okay", "fechado", "combinado", "show", "perfeito", "beleza", "blz"]) {
      expect(isQuickGreeting(msg)).toBe(false);
    }
  });

  test("rejects task requests, questions, code, URLs, multiline, empty, and long messages", () => {
    for (const msg of [
      "",
      "   ",
      "👋",
      "oi, pode revisar o PR 123?",
      "olá, faz um resumo do arquivo foo.ts",
      "verifica https://example.com",
      "ok, agora roda o deploy",
      "bom dia\npreciso de ajuda com um bug",
      "olha `src/app.ts`",
      "a".repeat(100),
    ]) {
      expect(isQuickGreeting(msg)).toBe(false);
    }
  });
});

describe("isQuickCleanReply", () => {
  test("accepts short clean conversational replies", () => {
    for (const reply of [
      "Oi! Tudo bem? Como posso te ajudar hoje?",
      "De nada! Qualquer coisa é só chamar.",
      "Hello! How can I help?",
    ]) {
      expect(isQuickCleanReply(reply)).toBe(true);
    }
  });

  test("rejects empty replies, promises of work, refusals, credential asks, code fences, and long replies", () => {
    for (const reply of [
      "",
      "   ",
      "Vou verificar isso agora para você.",
      "Deixa eu checar os logs.",
      "I'll check that right away.",
      "Não consigo acessar esse repositório.",
      "Me passa sua senha ou api key.",
      "Aqui está:\n```ts\nconsole.log(1)\n```",
      "x".repeat(351),
    ]) {
      expect(isQuickCleanReply(reply)).toBe(false);
    }
  });
});
