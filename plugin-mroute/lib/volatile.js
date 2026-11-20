/**
 * volatile 双面读取 helper（Day 1 实测 C5）。
 * volatile 字段经 schema 解析后是 Volatile 访问器（须 .get()）；
 * 非 volatile 字段与裸值（测试/编程挂载）原样返回。autotier resolveConfig 同款双面兼容模式。
 */
export function readVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}
