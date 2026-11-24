import { expect, test } from "bun:test";
import { createS3BlobStore, StorageError } from "../src";

const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "my-bucket",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  pathStyle: true,
};

test("stat returns metadata via HEAD and null on 404", async () => {
  const seen: { method: string; url: string; headers: Headers }[] = [];
  const store = createS3BlobStore(SETTINGS, {
    now: () => new Date("2026-10-14T12:00:00Z"),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({ method: init.method ?? "GET", url, headers });
      if (url.endsWith("/missing")) return new Response(null, { status: 404 });
      if (url.endsWith("/forbidden")) return new Response("", { status: 403 });
      return new Response(null, {
        status: 200,
        headers: { "content-length": "42", "content-type": "audio/webm" },
      });
    },
  });

  expect(await store.stat?.("clip.webm")).toEqual({ size: 42, contentType: "audio/webm" });
  expect(seen[0]?.method).toBe("HEAD");
  expect(seen[0]?.url).toBe("https://s3.example.test/my-bucket/clip.webm");
  expect(await store.stat?.("missing")).toBeNull();
  await expect(store.stat?.("forbidden")).rejects.toBeInstanceOf(StorageError);
});

test("readRange sends and signs the Range header, parses total size, and returns null on 404", async () => {
  const seen: { method: string; url: string; headers: Headers }[] = [];
  const store = createS3BlobStore(SETTINGS, {
    now: () => new Date("2026-10-14T12:00:00Z"),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({ method: init.method ?? "GET", url, headers });
      if (url.endsWith("/missing")) {
        return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      }
      if (headers.get("range") === "bytes=2-5") {
        return new Response("2345", {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": "4",
            "content-range": "bytes 2-5/10",
          },
        });
      }
      return new Response("0123456789", {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "10" },
      });
    },
  });

  const slice = await store.readRange?.("vid.mp4", { start: 2, end: 5 });
  if (!slice) throw new Error("expected slice");
  expect(slice.size).toBe(10);
  expect(slice.contentType).toBe("video/mp4");
  expect(await new Response(slice.body).text()).toBe("2345");
  expect(seen[0]?.headers.get("range")).toBe("bytes=2-5");
  expect(seen[0]?.headers.get("authorization")).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");

  const full = await store.readRange?.("vid.mp4");
  if (!full) throw new Error("expected full");
  expect(full.size).toBe(10);
  expect(await new Response(full.body).text()).toBe("0123456789");
  expect(seen[1]?.headers.get("range")).toBeNull();

  expect(await store.readRange?.("missing", { start: 0, end: 3 })).toBeNull();
});
