import { describe, expect, it } from "vitest";
import { groupProjects, type ProjectLike } from "./projectGroups.js";

const now = new Date("2026-09-23T15:00:00"); // 周三
const p = (id: string, updatedAt: string, status?: "active" | "archived"): ProjectLike => ({ id, updatedAt, status });

describe("groupProjects(时间分组)", () => {
  it("今天/本周/本月/更早 分桶正确,组内倒序,已归档单独成组居末", () => {
    const groups = groupProjects(
      [
        p("earlier", "2026-08-01T10:00:00"),
        p("today-old", "2026-09-23T08:00:00"),
        p("today-new", "2026-09-23T14:00:00"),
        p("week-tue", "2026-09-22T10:00:00"), // 周二,本周内
        p("week-mon", "2026-09-21T09:00:00"), // 周一,本周内
        p("month", "2026-09-20T10:00:00"), // 周日,属上一周 → 本月
        p("arch", "2026-09-23T12:00:00", "archived"),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["today", "week", "month", "earlier", "archived"]);
    expect(groups.find((g) => g.key === "today")!.items.map((x) => x.id)).toEqual(["today-new", "today-old"]);
    expect(groups.find((g) => g.key === "week")!.items.map((x) => x.id)).toEqual(["week-tue", "week-mon"]);
    expect(groups.find((g) => g.key === "month")!.items.map((x) => x.id)).toEqual(["month"]);
    expect(groups.find((g) => g.key === "archived")!.items.map((x) => x.id)).toEqual(["arch"]);
  });

  it("空组不输出;缺省 status 视为进行中", () => {
    const groups = groupProjects([p("a", "2026-09-23T10:00:00")], now);
    expect(groups.map((g) => g.key)).toEqual(["today"]);
  });

  it("周一起点边界:周日凌晨属于上周(归入本月),周一凌晨属今天", () => {
    const mondayEarly = new Date("2026-09-21T00:30:00");
    const groups = groupProjects([p("sun-late", "2026-09-20T23:30:00"), p("mon", "2026-09-21T00:10:00")], mondayEarly);
    expect(groups.map((g) => g.key)).toEqual(["today", "month"]);
  });
});
