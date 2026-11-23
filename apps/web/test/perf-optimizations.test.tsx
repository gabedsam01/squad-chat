import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { MESSAGES_PAGE } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ArtifactViewerProvider } from "@/components/artifacts/viewer-context";
import { useDirectory } from "@/hooks/useDirectory";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

describe("frontend performance optimizations", () => {
  test("ArtifactCard defers fetching offscreen artifacts until intersecting", async () => {
    const NativeIO = globalThis.IntersectionObserver;
    const instances: {
      cb: IntersectionObserverCallback;
      elements: Element[];
    }[] = [];
    globalThis.IntersectionObserver = class {
      cb: IntersectionObserverCallback;
      elements: Element[] = [];
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        instances.push(this);
      }
      observe(el: Element) {
        this.elements.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;

    try {
      const state = seedState();
      const api = createFakeApi(state);
      const created = await api.artifacts.create(ORG_ID, {
        title: "Relatório Q4",
        content: { kind: "document", markdown: "# Q4\n\nResumo completo." },
      });
      let artifactGets = 0;
      const origGet = api.artifacts.get;
      api.artifacts.get = async (...args) => {
        artifactGets++;
        return origGet(...args);
      };
      await renderPage(
        <ArtifactViewerProvider>
          <ArtifactCard artifact={{ id: created.id, version: 1, title: "Relatório Q4" }} />
        </ArtifactViewerProvider>,
        {
          api,
          org: true,
        },
      );
      await settle(3);

      expect(artifactGets).toBe(0);
      expect(document.querySelector(".artifact-tile--loading")).not.toBeNull();
      expect(document.body.textContent).not.toContain("Resumo completo.");

      const target = instances[0]?.elements[0];
      expect(target).toBeDefined();
      await act(async () => {
        for (const inst of instances) {
          if (inst.elements.length === 0) continue;
          inst.cb(
            inst.elements.map((el) => ({ target: el, isIntersecting: true }) as IntersectionObserverEntry),
            {} as IntersectionObserver,
          );
        }
      });
      await settle(5);

      expect(artifactGets).toBeGreaterThanOrEqual(1);
      expect(document.querySelector(".artifact-tile--loading")).toBeNull();
      expect(document.body.textContent).toContain("Relatório Q4");
    } finally {
      globalThis.IntersectionObserver = NativeIO;
    }
  });

  test("DirectoryProvider shares one set of directory queries across many consumers", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let agentListCalls = 0;
    let memberCalls = 0;
    let roleCalls = 0;
    const origAgents = api.agents.list;
    const origMembers = api.orgs.members;
    const origRoles = api.roles.list;
    api.agents.list = async (...args) => {
      agentListCalls++;
      return origAgents(...args);
    };
    api.orgs.members = async (...args) => {
      memberCalls++;
      return origMembers(...args);
    };
    api.roles.list = async (...args) => {
      roleCalls++;
      return origRoles(...args);
    };
    function Row({ i }: { i: number }) {
      const dir = useDirectory(ORG_ID);
      return <span data-testid={`row-${i}`}>{dir.agents.length}</span>;
    }
    await renderPage(
      Array.from({ length: 40 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static test list
        <Row key={i} i={i} />
      )),
      { api, org: true },
    );
    await settle(4);
    expect(screen().getByTestId("row-0").textContent).toBe(String(state.agents.length));
    expect(agentListCalls).toBe(1);
    expect(memberCalls).toBe(1);
    expect(roleCalls).toBe(1);
  });

  test("ChannelPage wheel-up at scrollTop 0 triggers loadOlder and failure surfaces a retry pill", async () => {
    const total = MESSAGES_PAGE + 15;
    const baseMs = Date.now() - total * 60_000;
    const personId = seedState().me?.user.id ?? "00000000-0000-4000-8000-000000000009";
    const state = seedState({
      messages: Array.from({ length: total }, (_, i) => ({
        id: `m-${String(i + 1).padStart(3, "0")}`,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person" as const, id: personId },
        body: `[msg:${String(i + 1).padStart(3, "0")}]`,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(baseMs + i * 60_000).toISOString(),
      })),
    });
    const api = createFakeApi(state);
    const origMessages = api.chat.messages;
    let beforeCalls = 0;
    let failBefore = true;
    api.chat.messages = async (orgId, channelId, opts) => {
      if (opts?.before) {
        beforeCalls++;
        if (failBefore) throw new Error("network down");
      }
      return origMessages(orgId, channelId, opts);
    };

    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);

    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: 0 });

    expect(document.body.textContent).not.toContain("[msg:010]");

    await act(async () => fireEvent.wheel(log, { deltaY: -120 }));
    await settle(4);

    expect(beforeCalls).toBe(1);
    const retry = screen().getByRole("button", { name: "Tentar de novo" });
    expect(retry).toBeTruthy();

    failBefore = false;
    await act(async () => fireEvent.click(retry));
    await settle(5);

    expect(beforeCalls).toBe(2);
    expect(document.body.textContent).toContain("[msg:010]");
  });
});
