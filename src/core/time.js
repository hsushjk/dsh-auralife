const toMinutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function inRange(date, from, to) {
  const a = toMinutes(from)
  const b = toMinutes(to)
  if (a === null || b === null) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return a > b ? now >= a || now < b : now >= a && now < b
}
