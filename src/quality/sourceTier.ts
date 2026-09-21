/**
 * 信源分级(参考 flow-center 商圈研究 ABC 模型):
 * A = 官方数据/政府公报/交易所与财报平台/权威媒体一手报道
 * B = 行业报告/专业数据平台/门户网站二次整理
 * C = 论坛/社媒/自媒体/个人博客/未知来源(需交叉验证)
 * 模块 preferredDomains 命中的域名强制提为 A(模块声明的一手来源)。
 */
export type SourceTier = "A" | "B" | "C";

const TIER_A_HOSTS = [
  // 政府与统计
  "gov.cn",
  "stats.gov.cn",
  // 交易所与法定信披
  "sse.com.cn",
  "szse.cn",
  "hkexnews.hk",
  "cninfo.com.cn",
  "neeq.com.cn",
  // 权威媒体(一手报道)
  "xinhuanet.com",
  "people.com.cn",
  "cctv.com",
  "gmw.cn",
];

const TIER_B_HOSTS = [
  // 财经/权威商业媒体
  "21jingji.com",
  "yicai.com",
  "caixin.com",
  "thepaper.cn",
  "jiemian.com",
  "eeo.com.cn",
  "nbd.com.cn",
  "stcn.com",
  "cnstock.com",
  "cls.cn",
  // 行业报告与数据平台
  "iresearch.com.cn",
  "analysys.cn",
  "questmobile.com.cn",
  "199it.com",
  "chinabaogao.com",
  "askci.com",
  "chyxx.com",
  "leadleo.com",
  "euromonitor.com",
  "statista.com",
  // 门户与科技媒体(二次整理)
  "sina.com.cn",
  "163.com",
  "qq.com",
  "sohu.com",
  "ifeng.com",
  "36kr.com",
  "huxiu.com",
  "tmtpost.com",
];

const TIER_C_HOSTS = [
  "zhihu.com",
  "xiaohongshu.com",
  "douyin.com",
  "weibo.com",
  "baijiahao.baidu.com",
  "toutiao.com",
  "bilibili.com",
  "mp.weixin.qq.com",
  "sohu.com/a/",
  "kuaishou.com",
  "douban.com",
  "tieba.baidu.com",
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const matches = (host: string, list: string[]): boolean =>
  list.some((d) => host === d || host.endsWith(`.${d}`) || host.endsWith(d));

export function tierOfSource(url: string, preferredDomains: string[] = []): SourceTier {
  const host = hostOf(url);
  if (!host) return "C";
  if (preferredDomains.length > 0 && matches(host, preferredDomains)) return "A";
  if (matches(host, TIER_A_HOSTS)) return "A";
  if (matches(host, TIER_B_HOSTS)) return "B";
  if (matches(host, TIER_C_HOSTS)) return "C";
  return "C"; // 未知来源按最低级处理,需交叉验证
}

export const TIER_LABEL: Record<SourceTier, string> = {
  A: "A级(官方/权威一手)",
  B: "B级(行业报告/专业平台)",
  C: "C级(社媒/自媒体/未知)",
};
