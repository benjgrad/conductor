// Bounded byte buffer keeping the last `limit` bytes of combined stdout+stderr (cmd_exit.output_tail).

export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.limit <= 0 || chunk.length === 0) return;
    if (chunk.length >= this.limit) {
      this.chunks = [chunk.subarray(chunk.length - this.limit)];
      this.size = this.limit;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) {
      const head = this.chunks[0]!;
      const over = this.size - this.limit;
      if (head.length <= over) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.size -= over;
      }
    }
  }

  /** UTF-8 text of the tail; a multi-byte character cut at the front is dropped, not mangled. */
  toString(): string {
    let buf = Buffer.concat(this.chunks, this.size);
    let start = 0;
    // Skip UTF-8 continuation bytes (10xxxxxx) left over from a character cut by the trim.
    while (start < buf.length && start < 3 && (buf[start]! & 0xc0) === 0x80) start++;
    if (start > 0) buf = buf.subarray(start);
    return buf.toString('utf8');
  }
}
