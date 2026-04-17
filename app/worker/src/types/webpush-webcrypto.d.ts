declare module "webpush-webcrypto" {
  export interface SerializedKeys {
    publicKey: string;
    privateKey: string;
  }

  export class ApplicationServerKeys {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
    constructor(publicKey: CryptoKey, privateKey: CryptoKey);
    toJSON(): Promise<SerializedKeys>;
    static fromJSON(keys: SerializedKeys): Promise<ApplicationServerKeys>;
    static generate(): Promise<ApplicationServerKeys>;
  }

  export interface PushTarget {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  export interface GeneratePushHTTPRequestOptions {
    applicationServerKeys: ApplicationServerKeys;
    payload: string | ArrayBuffer | ArrayBufferView;
    target: PushTarget;
    adminContact: string;
    ttl: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    topic?: string;
  }

  export interface GeneratedPushRequest {
    endpoint: string;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }

  export function generatePushHTTPRequest(
    options: GeneratePushHTTPRequestOptions,
  ): Promise<GeneratedPushRequest>;

  export function setWebCrypto(crypto: Crypto): void;
}
