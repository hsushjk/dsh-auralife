// 器官自举的安全闸（organ-guard）：静态检查 LLM 生成的器官代码，拒绝危险 API。
//
// 两道闸的设计：
// 1. 静态正则（本文件）：拒绝 require/child_process/eval/process.env 等危险 API + 非白名单 import。
// 2. 运行时白名单（organ-host）：器官只能通过 create(api) 拿到的 net/store/llm/log 做事，
//    拿不到 fs/process/globalThis，从根上断掉越权。
//
// 器官代码形状（LLM 生成）：
//   export const meta = { id, name, description, capabilities: [{id,name,description}] }
//   export function create(api) { return { ...器官实例，可选 tick() } }
//   // api = { net, store, llm, log }（白名单，organ-host 注入）

const FORBIDDEN = [
  { re: /\brequire\s*\(/, name: 'require()' },
  { re: /\bchild_process\b/, name: 'child_process' },
  { re: /\bexec\s*\(/, name: 'exec()' },
  { re: /\bspawn\s*\(/, name: 'spawn()' },
  { re: /\bfork\s*\(/, name: 'fork()' },
  { re: /\beval\s*\(/, name: 'eval()' },
  { re: /\bnew\s+Function\b/, name: 'new Function()' },
  { re: /\bprocess\s*\.\s*env\b/, name: 'process.env' },
  { re: /\bprocess\s*\.\s*(exit|kill|chdir|abort)/, name: 'process.exit/kill/chdir' },
  { re: /\bglobalThis\b/, name: 'globalThis' },
  { re: /\bWebSocket\b/, name: 'WebSocket（需走 net 白名单）' },
  { re: /\bconstructor\s*\[\s*['"](constructor|prototype)['"]/, name: '原型链污染' },
  { re: /\b__proto__\b/, name: '__proto__' },
  { re: /\bwhile\s*\(\s*true\s*\)/, name: 'while(true) 死循环（同步死循环会卡死插件进程，超时也救不了）' },
  { re: /\bfor\s*\(\s*;;\s*\)/, name: 'for(;;) 死循环' },
]

const ALLOWED_IMPORTS = new Set(['net', 'store', 'llm', 'log'])

export function guardOrgan(code) {
  const problems = []
  for (const f of FORBIDDEN) {
    if (f.re.test(code)) problems.push(f.name)
  }
  // 只允许白名单 bare import；相对路径和 node: 也不放行（器官只能拿 create(api) 注入的白名单）。
  const importRe = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = importRe.exec(code))) {
    const src = m[1]
    if (!ALLOWED_IMPORTS.has(src)) problems.push(`import '${src}' 不在白名单`)
  }
  return { ok: problems.length === 0, problems }
}
