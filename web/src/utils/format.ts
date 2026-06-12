// 通用格式化工具。

/** 人类可读字节数（与各页本地实现一致，抽出共享）。 */
export function formatBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}
