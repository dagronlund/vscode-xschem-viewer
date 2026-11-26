import { describe, expect, it } from "vitest";
import { FileResolver } from "../src/resolver";

describe("local file resolution", () => {
  const files: Record<string, string> = {
    "file:///workspace/project/schematic/child.sym": "project child",
    "file:///workspace/lib/child.sym": "library child",
    "file:///workspace/lib/block/nested.sym": "relative nested",
    "file:///workspace/lib/sg13_pr/mos.sym": "PDK MOS",
    "file:///workspace/lib/name%20%23%3F%25.sym": "special name",
  };
  const resolver = new FileResolver(
    ["file:///workspace/project", "file:///workspace/lib"],
    async (uri) => {
      if (!(uri in files)) throw new Error("not found");
      return files[uri];
    },
  );

  it("searches relative to each containing symbol before configured roots", async () => {
    expect(
      (
        await resolver.load(
          "child.sym",
          "file:///workspace/project/schematic/top.sch",
        )
      ).content,
    ).toBe("project child");
    expect(
      (
        await resolver.load(
          "nested.sym",
          "file:///workspace/lib/block/container.sym",
        )
      ).content,
    ).toBe("relative nested");
    expect(
      (
        await resolver.load(
          "sg13_pr/mos.sym",
          "file:///workspace/project/schematic/top.sch",
        )
      ).content,
    ).toBe("PDK MOS");
  });

  it("keeps URL metacharacters in filenames and supports absolute local URIs", async () => {
    expect(
      (await resolver.load("name #?%.sym", "file:///workspace/project/top.sch"))
        .content,
    ).toBe("special name");
    expect(
      (
        await resolver.load(
          "file:///workspace/lib/child.sym",
          "file:///workspace/project/top.sch",
        )
      ).content,
    ).toBe("library child");
  });

  it("reports the complete search and does not fall back to network access", async () => {
    await expect(
      resolver.load("missing.sym", "file:///workspace/project/top.sch"),
    ).rejects.toThrow("file:///workspace/lib/missing.sym");
    await expect(
      resolver.load(
        "https://example.com/mos.sym",
        "file:///workspace/project/top.sch",
      ),
    ).rejects.toThrow("outside the library roots");
    await expect(
      resolver.load("../../secret.sym", "file:///workspace/project/top.sch"),
    ).rejects.toThrow("outside the library roots");
  });
});
