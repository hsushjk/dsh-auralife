// 极简路由表：按注册顺序匹配，先精确后前缀。
export function createRouter() {
  const table = []

  function push(exact) {
    return (method, path, handler) => { table.push({ method: method.toUpperCase(), path, handler, exact }) }
  }

  const add = push(true)
  const prefix = push(false)

  function match(method, p) {
    for (const r of table) {
      if (r.method !== method) continue
      if (r.exact ? p === r.path : p.startsWith(r.path)) return r
    }
    return null
  }

  return { add, prefix, match, size: () => table.length }
}
