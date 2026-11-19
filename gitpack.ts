// Git object model, pkt-line framing and pack read/write.
// Plain objects only on the wire out (no deltas); the reader resolves
// OFS_DELTA and REF_DELTA for safety.
import { createHash } from 'node:crypto';
import { inflateSync as zinflate, deflateSync as zdeflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  // Two updates instead of Buffer.concat: no copy of the object bytes.
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer };

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Decode a whole buffer of pkt-lines. Throws on malformed input. */
export function decodePktLines(buf: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('bad pkt-line length');
    const raw = buf.subarray(offset, offset + len);
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len), raw });
    offset += len;
  }
  return packets;
}

/** Split a byte stream into pkt-line payload strings (data packets only). */
export function pktLineStrings(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
}

/** Encode a pack as sideband band-1 pkt-lines (chunks of at most 65515 bytes). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------------------------
// trees / commits / tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author} ${commit.timestamp} +0000`);
  lines.push(`committer ${commit.committer} ${commit.timestamp} +0000`);
  const message = commit.message.endsWith('\n') ? commit.message : `${commit.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function buildTag(tag: { object: string; type: GitObjectType; tag: string; tagger: string; message: string; timestamp: number }): Buffer {
  const message = tag.message.endsWith('\n') ? tag.message : `${tag.message}\n`;
  return Buffer.from(
    `object ${tag.object}\ntype ${tag.type}\ntag ${tag.tag}\ntagger ${tag.tagger} ${tag.timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

/** The target oid of an annotated tag object, or null. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (size & 0x0f) | (typeCode << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a pack (version 2, plain objects, no deltas) for the given objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const entries: Buffer[] = [];
  for (const object of objects) {
    const typeCode = PACK_TYPE_CODES[object.type];
    if (typeCode === undefined) throw new Error(`unknown object type ${object.type}`);
    // Level 0 (stored) zlib: the pack format only requires a valid zlib
    // stream, and stored blocks are ~5x faster to produce than level 6 for
    // the small objects in a clone pack. The client inflates them the same.
    entries.push(Buffer.concat([encodePackEntryHeader(typeCode, object.data.length), zdeflate(object.data, { level: 0 })]));
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The 32-byte empty pack (0 entries): 12-byte header + 20-byte trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  declaredCount: number;
  version: number;
  deltaCount: number;
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = data[offset] & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while ((data[pos - 1] & 0x80) !== 0) {
    value |= (data[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

function readOffsetVarint(data: Buffer, offset: number): { value: number; next: number } {
  let byte = data[offset];
  let value = byte & 0x7f;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = data[pos];
    value = ((value + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaSize = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readDeltaSize();
  const targetSize = readDeltaSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          copyOffset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          copySize |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (opcode !== 0) {
      parts.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Length of the zlib stream starting at `start` (inflated data already known).
 * The stream ends with the 4-byte Adler-32 of the inflated data, so search
 * for those bytes with Buffer.indexOf (native memmem, not a JS byte loop)
 * and verify the exact slice inflates to the same bytes. Falls back to a
 * binary search on inflate success.
 */
function compressedLength(pack: Buffer, start: number, end: number, inflated: Buffer): number {
  const adler = adler32(inflated);
  const needle = Buffer.allocUnsafe(4);
  needle.writeUInt32BE(adler, 0);
  let pos = start + 6;
  for (;;) {
    const found = pack.indexOf(needle, pos);
    if (found < 0 || found + 4 > end) break;
    try {
      const out = zinflate(pack.subarray(start, found + 4));
      if (out.equals(inflated)) return found + 4 - start;
    } catch {
      // Not the true end (a truncated slice throws); keep scanning.
    }
    pos = found + 1;
  }
  let lo = start + 1;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      zinflate(pack.subarray(start, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo - start;
}

/** Read a pack (v2 or v3), resolving deltas. Throws on a bad checksum or structure. */
export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const expectedTrailer = sha1Hex(pack.subarray(0, pack.length - 20));
  const actualTrailer = pack.subarray(pack.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const offsetToOid = new Map<number, string>();
  interface PendingDelta {
    entryOffset: number;
    baseOid: string | null;
    baseOffset: number | null;
    delta: Buffer;
  }
  const pendingDeltas: PendingDelta[] = [];
  let deltaCount = 0;
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= end) throw new Error('pack truncated');
    const entryOffset = offset;
    const first = pack[offset];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let pos = offset + 1;
    while ((pack[pos - 1] & 0x80) !== 0) {
      size |= (pack[pos] & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    if (typeCode === 6) {
      const base = readOffsetVarint(pack, pos);
      const baseOffset = entryOffset - base.value;
      const inflated = zinflate(pack.subarray(base.next, end));
      pendingDeltas.push({ entryOffset, baseOid: null, baseOffset, delta: inflated });
      deltaCount += 1;
      offset = base.next + compressedLength(pack, base.next, end, inflated);
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      const inflated = zinflate(pack.subarray(pos + 20, end));
      pendingDeltas.push({ entryOffset, baseOid, baseOffset: null, delta: inflated });
      deltaCount += 1;
      offset = pos + 20 + compressedLength(pack, pos + 20, end, inflated);
    } else {
      const type = PACK_TYPE_NAMES[typeCode];
      if (type === undefined) throw new Error(`unknown pack type ${typeCode}`);
      const inflated = zinflate(pack.subarray(pos, end));
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated);
      objects.set(oid, { type, data: inflated });
      offsetToOid.set(entryOffset, oid);
      offset = pos + compressedLength(pack, pos, end, inflated);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolve.
  let remaining = pendingDeltas;
  for (let round = 0; round < 100 && remaining.length > 0; round += 1) {
    const next: PendingDelta[] = [];
    for (const pending of remaining) {
      let base: GitObject | undefined;
      if (pending.baseOffset !== null) {
        const baseOid = offsetToOid.get(pending.baseOffset);
        base = baseOid === undefined ? undefined : objects.get(baseOid);
      } else if (pending.baseOid !== null) {
        base = objects.get(pending.baseOid);
      }
      if (base === undefined) {
        next.push(pending);
        continue;
      }
      const data = applyDelta(base.data, pending.delta);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      offsetToOid.set(pending.entryOffset, oid);
    }
    if (next.length === remaining.length) break;
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('unresolved pack deltas');
  return { objects, declaredCount, version, deltaCount };
}
