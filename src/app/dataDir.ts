import { join } from "node:path";

/**
 * 研究数据默认目录:寄居仓库内(双机经 git 同步);env DEEP_RESEARCH_DATA_DIR 可覆盖。
 */
export function defaultDataDir(): string {
  return process.env.DEEP_RESEARCH_DATA_DIR ?? join(process.cwd(), "research-data");
}
