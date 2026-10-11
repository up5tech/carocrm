import { MetadataRegistry } from '../registry/index.js';

export class MetadataCache {
  private cache = new Map<string, { version: number; data: unknown }>();

  constructor(private registry: MetadataRegistry) {}

  get<T>(key: string): T | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    if (cached.version !== this.registry.getMetadataVersion()) {
      this.cache.delete(key);
      return undefined;
    }
    return cached.data as T;
  }

  set(key: string, data: unknown): void {
    this.cache.set(key, { version: this.registry.getMetadataVersion(), data });
  }

  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  getMetadata(): unknown {
    return this.get('metadata') ?? this.computeMetadata();
  }

  private computeMetadata(): unknown {
    const data = this.registry.getMetadata();
    this.set('metadata', data);
    return data;
  }
}