import type { Identity, MemoryLevel, ScopeType } from "../types.js";

export interface IndexRecord {
  memoryId: string;
  ownerId: string;
  botId: string;
  scopeType: ScopeType;
  scopeKey: string;
  level: MemoryLevel;
  vector: number[];
}

export interface IndexMatch { memoryId: string; score: number; level: MemoryLevel }

interface Member extends IndexRecord { binary: Uint8Array }
interface Cluster { centroid: number[]; members: Member[] }

function dot(a: readonly number[], b: readonly number[]): number {
  let value = 0; for (let index = 0; index < a.length; index++) value += a[index]! * b[index]!; return value;
}

function norm(a: readonly number[]): number { return Math.sqrt(dot(a, a)); }

export function cosine(a: readonly number[], b: readonly number[]): number {
  const denominator = norm(a) * norm(b); return denominator === 0 ? 0 : dot(a, b) / denominator;
}

export function binaryQuantize(vector: readonly number[]): Uint8Array {
  const output = new Uint8Array(Math.ceil(vector.length / 8));
  for (let index = 0; index < vector.length; index++) if (vector[index]! >= 0) output[index >> 3] = output[index >> 3]! | 1 << (index & 7);
  return output;
}

function popcount(value: number): number {
  value -= (value >>> 1) & 0x55; value = (value & 0x33) + ((value >>> 2) & 0x33); return (value + (value >>> 4)) & 0x0f;
}

export function binarySimilarity(a: Uint8Array, b: Uint8Array, dimensions: number): number {
  let different = 0; for (let index = 0; index < a.length; index++) different += popcount(a[index]! ^ b[index]!);
  return 1 - different / dimensions;
}

function mean(vectors: readonly number[][]): number[] {
  const result = Array(vectors[0]?.length ?? 0).fill(0) as number[];
  for (const vector of vectors) for (let index = 0; index < result.length; index++) result[index] = result[index]! + vector[index]!;
  for (let index = 0; index < result.length; index++) result[index] = result[index]! / vectors.length;
  return result;
}

function clusters(records: IndexRecord[], targetSize: number): Cluster[] {
  if (records.length === 0) return [];
  const count = Math.max(1, Math.ceil(records.length / targetSize));
  const centroids: number[][] = [records[0]!.vector.slice()];
  while (centroids.length < count) {
    let choice = records[0]!, distance = -Infinity;
    for (const record of records) {
      const nearest = Math.max(...centroids.map((centroid) => cosine(record.vector, centroid)));
      if (1 - nearest > distance) { distance = 1 - nearest; choice = record; }
    }
    centroids.push(choice.vector.slice());
  }
  let assignments = Array(records.length).fill(0) as number[];
  for (let iteration = 0; iteration < 8; iteration++) {
    assignments = records.map((record) => {
      let best = 0, score = -Infinity;
      for (let index = 0; index < centroids.length; index++) { const next = cosine(record.vector, centroids[index]!); if (next > score) { score = next; best = index; } }
      return best;
    });
    for (let index = 0; index < centroids.length; index++) {
      const vectors = records.filter((_, recordIndex) => assignments[recordIndex] === index).map((record) => record.vector);
      if (vectors.length > 0) centroids[index] = mean(vectors);
    }
  }
  return centroids.map((centroid, index) => ({ centroid, members: records.filter((_, recordIndex) => assignments[recordIndex] === index)
    .map((record) => ({ ...record, binary: binaryQuantize(record.vector) })) })).filter((cluster) => cluster.members.length > 0);
}

function key(record: Pick<IndexRecord, "ownerId" | "botId" | "level" | "scopeType" | "scopeKey">): string {
  return JSON.stringify([record.ownerId, record.botId, record.level, record.scopeType, record.scopeKey]);
}

function visibleKeys(identity: Identity, level: MemoryLevel): string[] {
  const result = [key({ ownerId: identity.ownerId, botId: identity.botId, level, scopeType: "bot", scopeKey: identity.botId })];
  if (identity.projectId) result.push(key({ ownerId: identity.ownerId, botId: identity.botId, level, scopeType: "project", scopeKey: identity.projectId }));
  result.push(key({ ownerId: identity.ownerId, botId: identity.botId, level, scopeType: "conversation", scopeKey: identity.conversationId }));
  return result;
}

export class NamespaceCentroidIndex {
  private buckets = new Map<string, Cluster[]>();
  constructor(private readonly targetClusterSize = 100) {}

  build(records: IndexRecord[]): void {
    this.buckets.clear();
    const grouped = new Map<string, IndexRecord[]>();
    for (const record of records) grouped.set(key(record), [...(grouped.get(key(record)) ?? []), record]);
    for (const [bucket, members] of grouped) this.buckets.set(bucket, clusters(members, this.targetClusterSize));
  }

  replaceNamespace(ownerId: string, botId: string, records: IndexRecord[]): void {
    for (const bucket of [...this.buckets.keys()]) {
      const [owner, bot] = JSON.parse(bucket) as string[];
      if (owner === ownerId && bot === botId) this.buckets.delete(bucket);
    }
    const grouped = new Map<string, IndexRecord[]>();
    for (const record of records) grouped.set(key(record), [...(grouped.get(key(record)) ?? []), record]);
    for (const [bucket, members] of grouped) this.buckets.set(bucket, clusters(members, this.targetClusterSize));
  }

  search(identity: Identity, level: MemoryLevel, query: number[], options: { topClusters?: number; binaryCandidates?: number; limit?: number } = {}): IndexMatch[] {
    const topClusters = options.topClusters ?? 5, binaryCandidates = options.binaryCandidates ?? 40, limit = options.limit ?? 10;
    const queryBinary = binaryQuantize(query); const candidates: Member[] = [];
    for (const bucket of visibleKeys(identity, level)) {
      const selected = [...(this.buckets.get(bucket) ?? [])].sort((a, b) => cosine(query, b.centroid) - cosine(query, a.centroid)).slice(0, topClusters);
      candidates.push(...selected.flatMap((cluster) => cluster.members));
    }
    const bq = candidates.map((record) => ({ record, score: binarySimilarity(queryBinary, record.binary, query.length) }))
      .sort((a, b) => b.score - a.score).slice(0, binaryCandidates);
    return bq.map(({ record }) => ({ memoryId: record.memoryId, level, score: cosine(query, record.vector) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }

  stats(): { buckets: number; clusters: number; members: number } {
    const values = [...this.buckets.values()]; return { buckets: values.length, clusters: values.reduce((sum, item) => sum + item.length, 0),
      members: values.reduce((sum, item) => sum + item.reduce((inner, cluster) => inner + cluster.members.length, 0), 0) };
  }
}

export function recallAtK(expected: readonly string[], actual: readonly string[], k: number): number {
  const wanted = new Set(expected.slice(0, k)); if (wanted.size === 0) return 1;
  return actual.slice(0, k).filter((id) => wanted.has(id)).length / wanted.size;
}
