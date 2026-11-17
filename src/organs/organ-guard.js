// 器官安全闸（organ-guard）：静态检查 LLM 生成的器官代码，拒绝危险 API。
//
// 三道闸的设计：
// 1. 静态正则（本文件）：拒绝 require/child_process/eval/process/全局 fetch/动态 import 等。
//    这只是「提高门槛」，挡不住蓄意混淆——所以它不是唯一防线。
// 2. 运行时隔离（organ-host + organ-worker）：self-made 器官跑在独立 worker_threads 里，
//    死循环/process.exit/内存爆炸只杀 worker，不拖死 DSH 插件进程；调用超时即终止并熔断。
// 3. 运行时白名单（worker 里的 create(api)）：器官只能通过 net/store/llm/log/tools 这些受控入口做事，
//    作用域里不给宿主对象；net 出口有 SSRF 过滤，所有动作进审计日志（organs/audit.jsonl）。
//
// 器官代码形状（LLM 生成）：
//   export const meta = { id, name, description, capabilities: [{id,name,description}] }
//   export function create(api) { return { ...器官实例，可选 tick() } }
//   // api = { net, store, llm, log, tools }（白名单，worker 注入）

const FORBIDDEN = [
  { re: /\brequire\s*\(/, name: 'require()' },
  { re: /\bchild_process\b/, name: 'child_process' },
  { re: /\bexec\s*\(/, name: 'exec()' },
  { re: /\bspawn\s*\(/, name: 'spawn()' },
  { re: /\bfork\s*\(/, name: 'fork()' },
  { re: /\beval\s*\(/, name: 'eval()' },
  { re: /\bnew\s+Function\b/, name: 'new Function()' },
  { re: /\bFunction\s*\(/, name: 'Function()' },
  { re: /\bprocess\b/, name: 'process' },
  { re: /\bglobalThis\b/, name: 'globalThis' },
  { re: /\bimport\s*\(/, name: '动态 import()' },
  { re: /\bimport\.meta\b/, name: 'import.meta' },
  { re: /\bfetch\s*\(/, name: '全局 fetch()（请用 api.net）' },
  { re: /\bXMLHttpRequest\b/, name: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, name: 'WebSocket（需走 net 白名单）' },
  { re: /\bWebAssembly\b/, name: 'WebAssembly' },
  { re: /\bconstructor\b/, name: 'constructor（原型链逃逸）' },
  { re: /\b__proto__\b/, name: '__proto__' },
  { re: /\bsetInterval\s*\(/, name: 'setInterval（长任务请用 tick()）' },
  { re: /\bsetTimeout\s*\(/, name: 'setTimeout' },
  { re: /\bqueueMicrotask\s*\(/, name: 'queueMicrotask' },
  { re: /\bwhile\s*\(\s*true\s*\)/, name: 'while(true) 死循环' },
  { re: /\bfor\s*\(\s*;\s*;\s*\)/, name: 'for(;;) 死循环' },
  { re: /\bDeno\b|\bBun\b/, name: 'Deno/Bun' },
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