// —— WAV 读写与转采样（AuraLife 自己的实现，2026-11 重写）——// 约定：只支持未压缩 PCM16。parseWav 拆出头部信息 + 样本数据；
// toMono16k 把任意采样率/声道的 PCM16 折叠成 16kHz 单声道（给 ASR 与语音条统一口径）。
export function parseWav(buf) {
  const bad = () => new Error('不是 WAV')
  if (buf.length < 12) throw bad()
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw bad()
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw bad()

  let cursor = 12
  let fmt = null
  let samples = null
  while (cursor + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', cursor, cursor + 4)
    const chunkSize = buf.readUInt32LE(cursor + 4)
    const payloadStart = cursor + 8
    if (chunkId === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(payloadStart),
        channels: buf.readUInt16LE(payloadStart + 2),
        rate: buf.readUInt32LE(payloadStart + 4),
        bits: buf.readUInt16LE(payloadStart + 14),
      }
    } else if (chunkId === 'data') {
      const payloadEnd = Math.min(buf.length, payloadStart + chunkSize)
      samples = buf.subarray(payloadStart, payloadEnd)
    }
    cursor = payloadStart + chunkSize + (chunkSize & 1) // 块大小按偶数字节对齐
  }
  if (!fmt || !samples) throw new Error('WAV 缺 fmt 或 data')
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('只支持 PCM16')
  return { ...fmt, data: samples }
}

export function buildWav(samples, rate) {
  const bytesPerSample = 2
  const dataBytes = samples.length * bytesPerSample
  const out = Buffer.alloc(44 + dataBytes)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16) // fmt 块长度
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // 单声道
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * bytesPerSample, 28) // 字节率
  out.writeUInt16LE(bytesPerSample, 32) // 块对齐
  out.writeUInt16LE(16, 34) // 位深
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2)
  return out
}

function clamp16(x) {
  return Math.max(-32768, Math.min(32767, Math.round(x)))
}

export function toMono16k(buf, target = 16000) {
  const { channels, rate, data } = parseWav(buf)
  const frameCount = Math.floor(data.length / (2 * channels))
  // 多声道逐帧取平均 → 单声道
  const mono = new Float64Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let acc = 0
    for (let ch = 0; ch < channels; ch++) acc += data.readInt16LE((i * channels + ch) * 2)
    mono[i] = acc / channels
  }
  // 线性插值重采样到 target Hz
  const outCount = Math.max(1, Math.floor((frameCount * target) / rate))
  const out = new Int16Array(outCount)
  for (let i = 0; i < outCount; i++) {
    const position = (i * rate) / target
    const left = Math.floor(position)
    const right = Math.min(frameCount - 1, left + 1)
    const t = position - left
    const value = mono[Math.min(left, frameCount - 1)] * (1 - t) + mono[right] * t
    out[i] = clamp16(value)
  }
  return buildWav(out, target)
}
