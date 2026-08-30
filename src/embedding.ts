import type { Config } from "./config.js";

export type EmbeddingPurpose = "query" | "document";
export interface Embedder {
  readonly dimensions: number;
  embed(text: string, purpose: EmbeddingPurpose): Promise<number[]>;
}

export const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
export const EMBEDDING_PREFIX = {
  query: "task: search result | query: ",
  document: "title: none | text: ",
} as const;
export function embeddingInput(text: string, purpose: EmbeddingPurpose): string { return `${EMBEDDING_PREFIX[purpose]}${text}`; }

export class EmbeddingGemma implements Embedder {
  readonly dimensions = 768;
  private extractorPromise?: Promise<any>;

  constructor(private readonly config: Pick<Config, "modelCacheDir">) {}

  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    const extractor = await this.extractor();
    const output = await extractor(embeddingInput(text, purpose), { pooling: "mean", normalize: true });
    const values = Array.from(output.data as Float32Array) as number[];
    if (values.length !== this.dimensions) throw new Error(`EmbeddingGemma returned ${values.length} dimensions`);
    return values;
  }

  private extractor(): Promise<any> {
    if (!this.extractorPromise) {
      this.extractorPromise = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
        env.cacheDir = this.config.modelCacheDir;
        return pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q4" });
      });
    }
    return this.extractorPromise;
  }
}
