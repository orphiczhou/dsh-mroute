/** 轻量错误消息提取（不抛出、不泄漏堆栈）。 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
