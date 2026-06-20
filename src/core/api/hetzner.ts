import type { CoolifyApiClient } from "./client.js";

export type HetznerResource = "locations" | "server-types" | "images" | "ssh-keys";

export class HetznerApi {
  constructor(private readonly client: CoolifyApiClient) {}

  list(resource: HetznerResource): Promise<Record<string, unknown>[]> {
    return this.client.request(`/hetzner/${encodeURIComponent(resource)}`);
  }
}
