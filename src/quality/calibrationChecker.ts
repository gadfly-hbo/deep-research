import type { Claim } from "../contracts.js";

/** 口径单位归一:剔除等价写法差异(人民币后缀、括注),避免把同一单位误判为口径混用。 */
export function normalizeUnit(unit: string): string {
  return unit
    .replace(/人民币/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export type CalibrationConflict =
  | {
      entity: string;
      period: string;
      kind: "unit-mix";
      claimIds: string[];
      units: string[];
    }
  | {
      entity: string;
      period: string;
      kind: "value-conflict";
      claimIds: string[];
      values: { claimId: string; value: number; unit: string }[];
    };

interface Group {
  entity: string;
  period: string;
  claims: Claim[];
}

export function checkCalibration(claims: Claim[]): CalibrationConflict[] {
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const claim of claims) {
    if (!claim.calibration) continue;
    const key = `${claim.calibration.entity}${claim.calibration.period}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        entity: claim.calibration.entity,
        period: claim.calibration.period,
        claims: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.claims.push(claim);
  }

  const sorted = [...groups].sort((a, b) =>
    `${a.entity}${a.period}`.localeCompare(`${b.entity}${b.period}`),
  );

  const conflicts: CalibrationConflict[] = [];
  for (const group of sorted) {
    const units = [...new Set(group.claims.map((c) => normalizeUnit(c.calibration!.unit)))];
    const claimIds = group.claims.map((c) => c.id).sort();
    if (units.length > 1) {
      conflicts.push({
        entity: group.entity,
        period: group.period,
        kind: "unit-mix",
        claimIds,
        units,
      });
    }
    const rows = group.claims
      .filter((c) => typeof c.calibration?.value === "number")
      .map((c) => ({
        claimId: c.id,
        value: c.calibration!.value!,
        unit: normalizeUnit(c.calibration!.unit),
      }));
    const byUnit = new Map<string, typeof rows>();
    for (const row of rows) {
      byUnit.set(row.unit, [...(byUnit.get(row.unit) ?? []), row]);
    }
    for (const unitRows of byUnit.values()) {
      if (new Set(unitRows.map((r) => r.value)).size > 1) {
        conflicts.push({
          entity: group.entity,
          period: group.period,
          kind: "value-conflict",
          claimIds: unitRows.map((r) => r.claimId).sort(),
          values: unitRows,
        });
      }
    }
  }
  return conflicts;
}
