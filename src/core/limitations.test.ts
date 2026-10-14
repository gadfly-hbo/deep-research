import { describe, expect, it } from "vitest";
import { addLimitation } from "./limitations.js";

describe("addLimitation", () => {
  it("追加新文案并保持顺序", () => {
    const list: string[] = [];
    addLimitation(list, "甲");
    addLimitation(list, "乙");
    expect(list).toEqual(["甲", "乙"]);
  });

  it("同文案去重,不产生第二条", () => {
    const list = ["甲"];
    addLimitation(list, "甲");
    addLimitation(list, "乙");
    addLimitation(list, "甲");
    expect(list).toEqual(["甲", "乙"]);
  });
});
