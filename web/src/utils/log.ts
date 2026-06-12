// 日志行「展示净化」：仅在前端渲染前剥掉对单实例视图无意义、且白白占据
// 横向空间的噪音。注意——只动展示，后端日志文件与核心逻辑一律不碰。
//
// frps 子进程模型下，每个 frps worker 各写自己的 <id>.log，单实例视图里一般
// 不含 `[inst=<id>]` 前缀；但为与姊妹项目 frpc 的日志处理逻辑保持一致、并兼容
// 历史/合并日志，这里仍做同款剥离，幂等无副作用：
//   1) `[inst=<id>]`：实例分流前缀（合并日志场景才有），单实例视图里冗余。
//   2) `[<16位hex>]`：frp 为每条连接会话生成的 runID（如 00b42428887e954b），
//      排障价值低却占宽度，一并剥掉。
//
// 设计取舍：
// - 前导 `\s*` 一起吞掉分隔空格，避免剥离后留下双空格。
// - runID 严格匹配 16 位 hex，宁可漏剥也不误删 message 里的普通方括号内容。
// - 不影响级别着色：级别标记 [D]/[I]/[W]/[E] 不落在这两段内。

const INST_PREFIX = /\s*\[inst=[^\]]*\]/g;
const RUN_ID = /\s*\[[0-9a-f]{16}\]/gi;

/** 剥掉日志行里的 `[inst=<id>]` 与 `[<runID>]` 两段噪音，仅用于前端展示。 */
export function stripLogNoise(line: string): string {
  if (!line) return line;
  return line.replace(INST_PREFIX, '').replace(RUN_ID, '');
}

/** 单行日志的级别（用于着色 / 级别筛选）。无法判定时归为 'other'。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'other';

export function logLineLevel(line: string): LogLevel {
  if (line.includes('[W]') || /\bwarn(ing)?\b/i.test(line)) return 'warn';
  if (line.includes('[E]') || /\berror\b|\bfailed\b/i.test(line)) return 'error';
  if (line.includes('[D]') || /\bdebug\b/i.test(line)) return 'debug';
  if (line.includes('[I]') || /\binfo\b/i.test(line)) return 'info';
  return 'other';
}

/** 级别 → 终端着色 className（与 index.css 的 .log-* 对应）。 */
export function logLineClass(line: string): string {
  switch (logLineLevel(line)) {
    case 'warn': return 'log-line log-warn';
    case 'error': return 'log-line log-error';
    case 'debug': return 'log-line log-debug';
    case 'info': return 'log-line log-info';
    default: return 'log-line';
  }
}
