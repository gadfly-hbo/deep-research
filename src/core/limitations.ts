/** limitations 披露去重:同一文案只记一次。有意重复的站点(复用资产逐条披露、disclose 指令原文)不经过此函数。 */
export function addLimitation(list: string[], note: string): void {
  if (!list.includes(note)) list.push(note);
}
