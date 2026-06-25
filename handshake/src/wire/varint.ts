/**
 * Byte plumbing for the native binary engine — LEB128 varints and
 * length-prefixed raw bytes. No knowledge of fields, tags, or schemas; the
 * Serializer (serializer.ts) layers that on top.
 *
 * varints are unsigned LEB128. Zig-zag (for signed int32) is applied by the
 * Serializer before calling varint(), not here.
 */

// ── Growable byte writer ───────────────────────────────────────────────────────

export class Writer {
    private buf = new Uint8Array(64)
    private len = 0

    private grow(extra: number): void {
        if (this.len + extra <= this.buf.length) return
        let cap = this.buf.length
        while (cap < this.len + extra) cap *= 2
        const next = new Uint8Array(cap)
        next.set(this.buf.subarray(0, this.len))
        this.buf = next
    }

    varint(value: number): void {
        this.grow(10)
        while (value >= 0x80) {
            this.buf[this.len++] = (value % 0x80) | 0x80
            value = Math.floor(value / 0x80)
        }
        this.buf[this.len++] = value
    }

    /** length-prefixed raw bytes. */
    lenBytes(bytes: Uint8Array): void {
        this.varint(bytes.length)
        this.grow(bytes.length)
        this.buf.set(bytes, this.len)
        this.len += bytes.length
    }

    done(): Uint8Array {
        return this.buf.slice(0, this.len)
    }
}

// ── Byte reader ────────────────────────────────────────────────────────────────

export class Reader {
    private off = 0
    private readonly end: number
    constructor(private readonly buf: Uint8Array) {
        this.end = buf.length
    }

    get more(): boolean {
        return this.off < this.end
    }

    varint(): number {
        let result = 0
        let mul = 1
        let count = 0
        let byte: number
        do {
            if (this.off >= this.end) throw new Error('wire: malformed varint (truncated frame)')
            byte = this.buf[this.off++]!
            result += (byte & 0x7f) * mul
            mul *= 0x80
            if (++count > 8) throw new Error('wire: malformed varint (too long)')
        } while ((byte & 0x80) !== 0)
        return result
    }

    take(len: number): Uint8Array {
        const start = this.off
        const stop = start + len
        if (len < 0 || stop > this.end) throw new Error('wire: malformed frame (length exceeds buffer)')
        this.off = stop
        return this.buf.slice(start, stop)
    }
}
